#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# One-shot bootstrap for a fresh Amazon Linux 2023 / Ubuntu EC2 instance.
#
#   curl -fsSL https://raw.githubusercontent.com/mraaziqp/savestate/main/scripts/aws-init.sh | bash
#
# Installs Docker, the compose plugin and the AWS CLI, clones the repo, and
# leaves you one step from running ./deploy-aws.sh.
#
# NOTE ON WHICH PATH TO TAKE: this is the EC2 route, which keeps nginx and
# Let's Encrypt and lets you attach a GPU instance for hardware transcoding.
# The serverless route (App Runner) is scripts/deploy-aws-serverless.sh and
# needs none of this — but it cannot transcode in hardware. Pick one; running
# both just pays twice.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/mraaziqp/savestate.git}"
APP_DIR="${APP_DIR:-$HOME/savestate}"

info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }

if   command -v dnf >/dev/null 2>&1; then PKG=dnf
elif command -v yum >/dev/null 2>&1; then PKG=yum
elif command -v apt-get >/dev/null 2>&1; then PKG=apt
else echo "Unsupported distro"; exit 1; fi
info "Package manager: $PKG"

info "Installing base tooling"
if [ "$PKG" = apt ]; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg git unzip
else
  sudo $PKG install -y -q ca-certificates curl git unzip
fi
ok "base tooling"

# ── Docker ───────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1; then
  ok "docker already present"
else
  info "Installing Docker"
  if [ "$PKG" = apt ]; then
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    sudo $PKG install -y -q docker
    # Amazon Linux ships no compose plugin; install it where docker looks for it.
    sudo mkdir -p /usr/libexec/docker/cli-plugins
    sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
      -o /usr/libexec/docker/cli-plugins/docker-compose
    sudo chmod +x /usr/libexec/docker/cli-plugins/docker-compose
  fi
  sudo systemctl enable --now docker
  # So docker works without sudo. Requires a new login to take effect.
  sudo usermod -aG docker "$USER" || true
  ok "docker installed (log out and back in for group membership)"
fi

# ── AWS CLI ──────────────────────────────────────────────────────────────────
if command -v aws >/dev/null 2>&1; then
  ok "aws cli already present"
else
  info "Installing AWS CLI v2"
  tmp=$(mktemp -d)
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/aws.zip"
  unzip -q "$tmp/aws.zip" -d "$tmp"
  sudo "$tmp/aws/install" --update
  rm -rf "$tmp"
  ok "aws cli installed"
fi

# ── Code ─────────────────────────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  info "Updating existing checkout"
  git -C "$APP_DIR" pull --ff-only
else
  info "Cloning $REPO_URL"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
ok "code at $APP_DIR"

cat <<NEXT

────────────────────────────────────────────────────────────────────────
Bootstrap complete.

  1. If docker was just installed, log out and back in (group membership).

  2. Provide secrets — this file is intentionally NOT in the repo:
       cd $APP_DIR
       cp .env.production.example .env.production   # if present
       nano .env.production
     It needs at minimum DATABASE_URL, JWT_SECRET, GEMINI_API_KEY, and the
     three GOOGLE_DRIVE_* values. There is no rclone mount on this host, so
     Drive access must go through the API.

  3. Issue the wildcard certificate (DNS-01; HTTP-01 cannot do wildcards):
       export CLOUDFLARE_API_TOKEN=...   # Zone:DNS:Edit on savestate.co.za
       ./deploy-aws.sh certs

  4. Bring it up:
       ./deploy-aws.sh up

  5. Point DNS at this instance:
       A     savestate.co.za   -> $(curl -s --max-time 3 ifconfig.me || echo '<this instance public IP>')
       CNAME *.savestate.co.za -> savestate.co.za
────────────────────────────────────────────────────────────────────────
NEXT
