#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Bring savestate.co.za up on THIS machine and prove it is reachable.
#
#   bash scripts/host-up.sh           check, (re)start everything, verify
#   bash scripts/host-up.sh --pull    also fetch the latest code first
#
# Run it on the host itself (on Windows: inside the WSL Ubuntu terminal).
# It never touches the old host. If another machine is still running the
# same tunnel, stop it there first or traffic is split between the two.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$HOME/.nexus-data"
DOMAIN="${NEXUS_DOMAIN:-savestate.co.za}"
PULL=0
[[ "${1:-}" == "--pull" ]] && PULL=1

ok()   { printf '\033[32m  ok\033[0m   %s\n' "$*"; }
warn() { printf '\033[33m  --\033[0m   %s\n' "$*"; }
bad()  { printf '\033[31m  !!\033[0m   %s\n' "$*"; FAILED=1; }
fix()  { printf '       \033[36mfix:\033[0m %s\n' "$*"; }
info() { printf '\n\033[36m==>\033[0m %s\n' "$*"; }
FAILED=0
have() { command -v "$1" >/dev/null 2>&1; }

cd "$APP_DIR" || exit 1

info "Preflight"
if grep -qi microsoft /proc/version 2>/dev/null; then
  ok "running in WSL"
  if [[ "$(ps -p 1 -o comm= 2>/dev/null)" != "systemd" ]]; then
    bad "systemd is not running in WSL"
    fix "printf '[boot]\\nsystemd=true\\n' | sudo tee -a /etc/wsl.conf   then in PowerShell: wsl --shutdown   and reopen Ubuntu"
    exit 1
  fi
fi
have systemctl || { bad "systemd not found"; exit 1; }
have node && ok "node $(node --version)" || { bad "node missing"; fix "bash scripts/setup-host.sh"; }
have cloudflared || [[ -x "$HOME/.local/bin/cloudflared" ]] && ok "cloudflared present" || { bad "cloudflared missing"; fix "bash scripts/setup-host.sh"; }
[[ -f "$APP_DIR/.env" ]] && ok ".env present" || { bad ".env missing (app secrets)"; fix "bash scripts/import-host-bundle.sh ~/savestate-host-bundle-*.tar.gz.gpg"; }
if compgen -G "$HOME/.cloudflared/*.json" >/dev/null; then ok "tunnel credential present"; else
  bad "tunnel credential missing — this is what carries the domain"
  fix "bash scripts/import-host-bundle.sh ~/savestate-host-bundle-*.tar.gz.gpg"
fi
[[ -f "$DATA_DIR/cloudflared/config.yml" ]] && ok "tunnel config present" || { bad "tunnel config missing ($DATA_DIR/cloudflared/config.yml)"; fix "re-run the bundle import"; }
for u in nexus-host cloudflared-nexus; do
  systemctl --user cat "$u" >/dev/null 2>&1 && ok "unit $u installed" || { bad "unit $u not installed"; fix "bash scripts/setup-host.sh"; }
done
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == "yes" ]]; then ok "linger on"; else
  warn "linger off — the site stops when you log out"
  fix "sudo loginctl enable-linger $USER"
fi
(( FAILED )) && { echo; bad "fix the items above, then run this again"; exit 1; }

if (( PULL )); then
  info "Updating code"
  git pull --ff-only && ok "code up to date" || warn "git pull failed — carrying on with the current code"
  if [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
    npm ci --no-audit --no-fund && ok "dependencies installed" || bad "npm ci failed"
  fi
fi
[[ -d node_modules ]] || { npm ci --no-audit --no-fund || { bad "npm ci failed"; exit 1; }; }

info "Starting services"
systemctl --user daemon-reload
# Drive first (the library), then the app, then the tunnel that exposes it.
for u in nexus-rclone-rcd nexus-cloud-media; do
  systemctl --user cat "$u" >/dev/null 2>&1 || continue
  systemctl --user enable "$u" >/dev/null 2>&1
  systemctl --user restart "$u" && ok "$u" || warn "$u failed — the library will be empty until Drive mounts (journalctl --user -u $u)"
done
systemctl --user enable nexus-host >/dev/null 2>&1
systemctl --user restart nexus-host && ok "nexus-host started" || bad "nexus-host failed to start"

info "Waiting for the app on :3000"
up=0
for _ in $(seq 1 45); do
  if curl -fsS -m 3 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then up=1; break; fi
  sleep 2
done
if (( up )); then ok "app answering locally"; else
  bad "app did not answer within 90s — last log lines:"
  journalctl --user -u nexus-host -n 25 --no-pager | sed 's/^/       /'
  exit 1
fi

systemctl --user enable cloudflared-nexus >/dev/null 2>&1
systemctl --user restart cloudflared-nexus && ok "tunnel started" || bad "tunnel failed to start"

info "Waiting for the tunnel to register"
reg=0
for _ in $(seq 1 30); do
  if journalctl --user -u cloudflared-nexus --since "-2min" --no-pager 2>/dev/null | grep -q "Registered tunnel connection"; then reg=1; break; fi
  sleep 2
done
if (( reg )); then ok "tunnel connected to Cloudflare"; else
  bad "tunnel did not register — last log lines:"
  journalctl --user -u cloudflared-nexus -n 25 --no-pager | sed 's/^/       /'
  fix "credential/config mismatch: check the tunnel id in $DATA_DIR/cloudflared/config.yml matches a file in ~/.cloudflared/"
  fix "blocked network: this uses outbound TCP 443 (--protocol http2); check firewall/VPN"
  exit 1
fi

info "Checking https://$DOMAIN from the outside"
ok_ext=0
for _ in $(seq 1 10); do
  hdr="$(curl -sS -m 15 -D - -o /dev/null "https://$DOMAIN/api/health" 2>/dev/null)"
  code="$(printf '%s' "$hdr" | head -1 | awk '{print $2}')"
  origin="$(printf '%s' "$hdr" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-savestate-origin"{print $2}')"
  if [[ "$code" == "200" ]]; then ok_ext=1; break; fi
  sleep 3
done
if (( ok_ext )); then
  ok "https://$DOMAIN/api/health -> 200${origin:+ (answered by: $origin)}"
  [[ -n "$origin" && "$origin" != "primary" ]] && warn "answered by '$origin', not this host — Cloudflare may still be failing over; retry in a minute"
else
  bad "https://$DOMAIN did not return 200 (last status: ${code:-none})"
  fix "if another machine still runs cloudflared-nexus, stop it: systemctl --user disable --now cloudflared-nexus nexus-host"
  exit 1
fi

echo
curl -s -m 60 "https://$DOMAIN/api/health/full" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s);console.log(`  overall: ${h.overall}  (${h.passed}/${h.total} passing, ${h.warned} warning)`);for(const c of h.checks||[])if(c.status!=="pass")console.log(`    ${c.status.padEnd(5)} ${c.name}: ${c.detail??c.message??""}`)}catch{console.log("  (full health report unavailable)")}})'
echo
ok "savestate.co.za is being served from this machine"
