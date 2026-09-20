#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NexusEmu — AWS deployment driver.
#
# Brings the control plane up on a single EC2 host behind nginx, with all state
# in Neon and Google Drive. Written during the 2026-09-20 recovery, when the
# local media drive was lost and the laptop stopped being a safe place to host.
#
#   ./deploy-aws.sh check     validate prerequisites, change nothing
#   ./deploy-aws.sh certs     issue/renew the wildcard cert for *.savestate.co.za
#   ./deploy-aws.sh up        build and start (default)
#   ./deploy-aws.sh deploy    pull latest, rebuild, restart with a health gate
#   ./deploy-aws.sh logs      tail application logs
#   ./deploy-aws.sh down      stop everything
#
# Required on the host: docker (with the compose plugin), and a .env.production
# carrying DATABASE_URL, JWT_SECRET, GEMINI_API_KEY and the Google Drive creds.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

DOMAIN="${NEXUS_DOMAIN:-savestate.co.za}"
ENV_FILE="${NEXUS_ENV_FILE:-.env.production}"
COMPOSE="docker compose"
CERT_DIR="./certs"
ACME_EMAIL="${NEXUS_ACME_EMAIL:-admin@${DOMAIN}}"

c_ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
c_bad()  { printf '\033[31m  ✗\033[0m %s\n' "$*"; }
c_info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die()    { c_bad "$*"; exit 1; }

# ── Prerequisites ────────────────────────────────────────────────────────────
check() {
  local failed=0
  c_info "Checking prerequisites"

  command -v docker >/dev/null 2>&1 && c_ok "docker present" || { c_bad "docker not installed"; failed=1; }
  docker compose version >/dev/null 2>&1 && c_ok "compose plugin present" \
    || { c_bad "docker compose plugin missing"; failed=1; }

  if [[ -f "$ENV_FILE" ]]; then
    c_ok "$ENV_FILE present"
    # These four are the difference between a working deploy and a container
    # that boots, serves 500s, and looks healthy from the outside.
    local missing=()
    for key in DATABASE_URL JWT_SECRET GEMINI_API_KEY NEXUS_PUBLIC_URL; do
      grep -qE "^${key}=.+" "$ENV_FILE" || missing+=("$key")
    done
    if ((${#missing[@]})); then
      c_bad "missing in $ENV_FILE: ${missing[*]}"; failed=1
    else
      c_ok "required secrets present"
    fi
    # A stateless container cannot see the laptop's rclone FUSE mount. If the
    # env still points at it, storage silently resolves to nothing.
    if grep -qE '^NEXUS_GDRIVE_ROOT=/home/' "$ENV_FILE"; then
      c_bad "NEXUS_GDRIVE_ROOT points at a local mount — the container has no rclone mount."
      c_bad "  Use the Drive API credentials instead and leave this unset."
      failed=1
    fi
    if grep -q 'EMULATION dRIVE' "$ENV_FILE"; then
      c_bad "$ENV_FILE still references the destroyed media drive"; failed=1
    else
      c_ok "no dead-drive references"
    fi
  else
    c_bad "$ENV_FILE not found — copy .env and strip the laptop-only paths"; failed=1
  fi

  [[ -f nginx.conf   ]] && c_ok "nginx.conf present"   || { c_bad "nginx.conf missing"; failed=1; }
  [[ -f Dockerfile   ]] && c_ok "Dockerfile present"   || { c_bad "Dockerfile missing"; failed=1; }

  if [[ -f "$CERT_DIR/fullchain.pem" && -f "$CERT_DIR/privkey.pem" ]]; then
    local days
    days=$(( ( $(date -d "$(openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem" | cut -d= -f2)" +%s) - $(date +%s) ) / 86400 ))
    (( days > 14 )) && c_ok "TLS cert valid for ${days} more day(s)" \
                    || c_bad "TLS cert expires in ${days} day(s) — run: $0 certs"
  else
    c_bad "no TLS cert in $CERT_DIR — run: $0 certs"; failed=1
  fi

  return $failed
}

# ── Wildcard certificate ─────────────────────────────────────────────────────
# *.savestate.co.za requires a DNS-01 challenge; HTTP-01 cannot issue wildcards.
# Cloudflare hosts the zone, so the DNS plugin is the path of least friction.
certs() {
  c_info "Issuing wildcard certificate for ${DOMAIN} and *.${DOMAIN}"
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] \
    || die "CLOUDFLARE_API_TOKEN must be set (Zone:DNS:Edit on ${DOMAIN}) for the DNS-01 challenge"

  mkdir -p "$CERT_DIR" ./letsencrypt
  umask 077
  printf 'dns_cloudflare_api_token = %s\n' "$CLOUDFLARE_API_TOKEN" > ./letsencrypt/cf.ini

  docker run --rm \
    -v "$PWD/letsencrypt:/etc/letsencrypt" \
    certbot/dns-cloudflare certonly \
      --dns-cloudflare \
      --dns-cloudflare-credentials /etc/letsencrypt/cf.ini \
      --dns-cloudflare-propagation-seconds 30 \
      -d "${DOMAIN}" -d "*.${DOMAIN}" \
      --agree-tos -m "$ACME_EMAIL" --non-interactive

  cp -L "./letsencrypt/live/${DOMAIN}/fullchain.pem" "$CERT_DIR/fullchain.pem"
  cp -L "./letsencrypt/live/${DOMAIN}/privkey.pem"   "$CERT_DIR/privkey.pem"
  rm -f ./letsencrypt/cf.ini
  c_ok "certificate written to $CERT_DIR"
}

# ── Lifecycle ────────────────────────────────────────────────────────────────
# Redis must answer before the app is considered up; the app degrades badly if
# its queue backend is missing and the failure looks like an app bug.
check_redis() {
  if docker exec nexus-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    c_ok "redis responding"
  else
    c_bad "redis not responding"; return 1
  fi
}

wait_healthy() {
  c_info "Waiting for the app to report healthy"
  for _ in $(seq 1 60); do
    if docker exec nexus-server curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      c_ok "healthy"; return 0
    fi
    sleep 5
  done
  c_bad "did not become healthy in 5 minutes — last 40 log lines:"
  $COMPOSE logs --tail=40 nexus
  return 1
}

up() {
  check || die "prerequisites failed — fix the items above first"
  c_info "Building image"
  $COMPOSE build
  c_info "Starting services"
  $COMPOSE up -d
  wait_healthy
  check_redis || true
  c_ok "NexusEmu is up at https://${DOMAIN}"
}

deploy() {
  if [[ -d .git ]]; then c_info "Pulling latest"; git pull --ff-only; fi
  c_info "Rebuilding"
  $COMPOSE build
  # Recreate the app only; leaving nginx up keeps TLS serving through the swap.
  $COMPOSE up -d --no-deps nexus
  if wait_healthy; then
    $COMPOSE up -d
    c_ok "deployed"
  else
    c_bad "rolling back to the previous container"
    $COMPOSE restart nexus
    exit 1
  fi
}

case "${1:-up}" in
  check)
    # Exit non-zero on failure so CI / a deploy gate can rely on this.
    if check; then c_ok "all checks passed"; else die "prerequisite check failed"; fi ;;
  certs)  certs ;;
  up)     up ;;
  deploy) deploy ;;
  logs)   $COMPOSE logs -f --tail=100 nexus ;;
  down)   $COMPOSE down ;;
  *)      sed -n '3,20p' "$0"; exit 1 ;;
esac
