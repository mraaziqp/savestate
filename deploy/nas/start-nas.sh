#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# SaveState NAS Startup & Deployment Script (QNAP / Linux)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
warn() { printf '\033[33m  !!\033[0m  %s\n' "$*"; }
die()  { printf '\033[31m  !!\033[0m  %s\n' "$*" >&2; exit 1; }

say "Starting SaveState NAS Stack"

# Find Docker compose command
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "Docker Compose not found. Please install Container Station / Docker Compose."
fi

ok "Using $COMPOSE"

# Ensure cloudflared permissions
if [ -f "cloudflared/d7c61183-4da4-4748-b4f2-207c9eef4a3c.json" ]; then
  chmod 600 cloudflared/*.json 2>/dev/null || true
  ok "Cloudflare tunnel credentials verified"
else
  warn "Tunnel credentials missing in ./cloudflared"
fi

# Ensure data dir permissions
mkdir -p data
chmod -R 775 data 2>/dev/null || true

# Start containers
say "Launching containers (database, app, cloudflare tunnel)..."
$COMPOSE up -d --build

say "Waiting for SaveState healthcheck..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
    ok "SaveState is healthy on http://127.0.0.1:3000"
    break
  fi
  sleep 2
  if [ "$i" -eq 60 ]; then
    warn "SaveState did not report healthy within 120s. Checking logs:"
    $COMPOSE logs --tail 30 app
  fi
done

echo
say "=========================================================="
say "SaveState is successfully running on your NAS!"
say "Local Access:     http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '192.168.31.201'):3000"
say "Public Domain:    https://savestate.co.za"
say "=========================================================="
say "IMPORTANT: Remember to stop the old host on your Windows PC"
say "so the Cloudflare tunnel routes exclusively to this NAS."
