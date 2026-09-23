#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build, push to ECR, and deploy NexusEmu to AWS App Runner (or ECS Fargate).
#
#   ./scripts/deploy-aws-serverless.sh check     prerequisites only, changes nothing
#   ./scripts/deploy-aws-serverless.sh push      build + push the image to ECR
#   ./scripts/deploy-aws-serverless.sh deploy    push, then create/update the service
#   ./scripts/deploy-aws-serverless.sh status    show the service and its URL
#   ./scripts/deploy-aws-serverless.sh destroy   tear the stack down
#
# Secrets are NEVER baked into the image or passed on the command line. They go
# into AWS Secrets Manager and the service references them by ARN.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-eu-west-1}"
REPO="${ECR_REPO:-nexus-emu}"
STACK="${STACK_NAME:-nexus-emu}"
TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%s)}"
ENV_FILE="${NEXUS_ENV_FILE:-.env.production}"
SECRET_NAME="${SECRET_NAME:-nexus-emu/env}"

ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
bad()  { printf '\033[31m  ✗\033[0m %s\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die()  { bad "$*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. See 'check' for how to get it."; }

account_id() { aws sts get-caller-identity --query Account --output text --region "$REGION"; }
ecr_uri()    { echo "$(account_id).dkr.ecr.${REGION}.amazonaws.com/${REPO}"; }

# ── check ────────────────────────────────────────────────────────────────────
check() {
  local failed=0
  info "Prerequisites"

  if command -v docker >/dev/null 2>&1; then ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"
  else bad "docker not installed —  curl -fsSL https://get.docker.com | sudo sh  &&  sudo usermod -aG docker \$USER"; failed=1; fi

  if command -v aws >/dev/null 2>&1; then ok "aws cli $(aws --version 2>&1 | awk '{print $1}' | cut -d/ -f2)"
  else bad "aws cli not installed —  curl 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip' -o a.zip && unzip -q a.zip && sudo ./aws/install"; failed=1; fi

  if command -v aws >/dev/null 2>&1; then
    if aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
      ok "aws credentials valid (account $(account_id), region $REGION)"
    else
      bad "aws credentials missing or expired — run: aws configure"; failed=1
    fi
  fi

  if [ -f "$ENV_FILE" ]; then
    ok "$ENV_FILE present"
    local missing=()
    for k in DATABASE_URL JWT_SECRET GEMINI_API_KEY; do
      grep -qE "^${k}=.+" "$ENV_FILE" || missing+=("$k")
    done
    ((${#missing[@]})) && { bad "missing in $ENV_FILE: ${missing[*]}"; failed=1; } || ok "required secrets present"
    # A container has no rclone mount; pointing at one silently yields no storage.
    grep -qE '^NEXUS_GDRIVE_ROOT=/home/' "$ENV_FILE" \
      && { bad "NEXUS_GDRIVE_ROOT points at a local mount — the container has none. Use the Drive API credentials."; failed=1; } \
      || ok "no local mount paths"
  else
    bad "$ENV_FILE not found"; failed=1
  fi

  [ -f Dockerfile ] && ok "Dockerfile present" || { bad "Dockerfile missing"; failed=1; }
  [ -f dist/index.html ] && ok "prebuilt frontend present" || { bad "dist/index.html missing"; failed=1; }

  return $failed
}

# ── secrets ──────────────────────────────────────────────────────────────────
# The whole .env becomes one JSON secret; the service reads individual keys from
# it. Keeps the task definition free of plaintext and lets rotation happen
# without redeploying.
sync_secret() {
  need aws
  info "Syncing $ENV_FILE into Secrets Manager as '$SECRET_NAME'"
  local json
  json=$(python3 - "$ENV_FILE" <<'PY'
import json,re,sys
out={}
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    m=re.match(r'^([A-Z0-9_]+)=(.*)$', line.strip())
    if m: out[m.group(1)]=m.group(2)
print(json.dumps(out))
PY
)
  if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" --secret-string "$json" --region "$REGION" >/dev/null
    ok "secret updated"
  else
    aws secretsmanager create-secret --name "$SECRET_NAME" --secret-string "$json" --region "$REGION" >/dev/null
    ok "secret created"
  fi
}

# ── build + push ─────────────────────────────────────────────────────────────
push() {
  need docker; need aws
  local uri; uri=$(ecr_uri)
  aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
    || { info "Creating ECR repository '$REPO'"; aws ecr create-repository --repository-name "$REPO" \
         --image-scanning-configuration scanOnPush=true --region "$REGION" >/dev/null; }

  info "Authenticating docker to ECR"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${uri%/*}"

  info "Building $REPO:$TAG"
  # linux/amd64 explicitly: Fargate and App Runner reject an arm64 image built
  # on an Apple Silicon machine, and the failure is opaque.
  docker build --platform linux/amd64 -t "$REPO:$TAG" -t "$REPO:latest" .

  info "Pushing"
  docker tag "$REPO:$TAG" "$uri:$TAG"
  docker tag "$REPO:latest" "$uri:latest"
  docker push "$uri:$TAG"
  docker push "$uri:latest"
  ok "pushed $uri:$TAG"
  echo "$uri:$TAG" > .last-image
}

# ── deploy ───────────────────────────────────────────────────────────────────
deploy() {
  check || die "prerequisites failed"
  sync_secret
  push
  need aws
  local uri; uri=$(ecr_uri)
  # Secrets Manager appends a random suffix to every ARN, so the template
  # cannot build it from the name -- look it up and pass it in.
  local secret_arn
  secret_arn=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" \
                 --region "$REGION" --query ARN --output text)
  ok "secret arn resolved"

  info "Deploying CloudFormation stack '$STACK'"
  aws cloudformation deploy \
    --template-file aws-infrastructure.yaml \
    --stack-name "$STACK" \
    --region "$REGION" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
        ImageUri="$uri:$TAG" \
        SecretName="$SECRET_NAME" \
        SecretArn="$secret_arn" \
        ServiceName="$STACK"
  status
}

status() {
  need aws
  local url
  url=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='ServiceUrl'].OutputValue" --output text 2>/dev/null || true)
  [ -n "$url" ] && [ "$url" != "None" ] || { bad "no ServiceUrl output yet"; return 1; }
  ok "Service URL: $url"
  info "Polling /api/health"
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/api/health" || true)
    [ "$code" = "200" ] && { ok "healthy (200)"; echo; echo "  Point savestate.co.za at: $url"; return 0; }
    sleep 10
  done
  bad "did not return 200 within 10 minutes"; return 1
}

destroy() {
  need aws
  info "Deleting stack '$STACK'"
  aws cloudformation delete-stack --stack-name "$STACK" --region "$REGION"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK" --region "$REGION"
  ok "deleted"
}

case "${1:-check}" in
  check)   check && ok "all checks passed" || die "prerequisite check failed" ;;
  secret)  sync_secret ;;
  push)    push ;;
  deploy)  deploy ;;
  status)  status ;;
  destroy) destroy ;;
  *)       sed -n '3,14p' "$0"; exit 1 ;;
esac
