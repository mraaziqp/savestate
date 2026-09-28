#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Turn a freshly cloned repo into a savestate host.
#
#   git clone git@github.com:mraaziqp/savestate.git NexussEmu
#   cd NexussEmu
#   bash scripts/setup-host.sh
#   bash scripts/import-host-bundle.sh ~/savestate-host-bundle-*.tar.gz[.gpg]
#
# This installs dependencies and renders the systemd units for THIS machine's
# home directory and clone path. It does not touch secrets — those arrive in
# the bundle, which is the only thing that cannot live in git.
#
# Linux + systemd only. On Windows the app still runs (`npm run dev`), but the
# tunnel and Drive mount need to be set up as Windows services instead.
#
#   --no-install   render units and check only; install nothing
#   --start        enable and start the services when finished
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DO_INSTALL=1
DO_START=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install) DO_INSTALL=0 ;;
    --start) DO_START=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

ok()   { printf '\033[32m  ok\033[0m   %s\n' "$*"; }
warn() { printf '\033[33m  --\033[0m   %s\n' "$*"; }
bad()  { printf '\033[31m  !!\033[0m   %s\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

command -v systemctl >/dev/null || { bad "systemd not found — this script is Linux only"; exit 1; }

info "Host setup for $APP_DIR"
echo

# ── Dependencies ─────────────────────────────────────────────────────────────
# Node 22 specifically: googleapis and pdfjs-dist both declare engines >=22 and
# warn loudly on 20, and the Docker image was moved to 22 for the same reason.
need_apt=()
have() { command -v "$1" >/dev/null 2>&1; }

check_dep() {
  local cmd="$1" pkg="$2" why="$3"
  if have "$cmd"; then ok "$cmd present"; else
    warn "$cmd missing — $why"
    need_apt+=("$pkg")
  fi
}

info "Dependencies"
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( NODE_MAJOR >= 22 )); then ok "node $(node --version)"
  else warn "node $(node --version) is too old — 22+ needed (googleapis, pdfjs-dist)"; fi
else
  bad "node missing — install Node 22+ (https://github.com/nodesource/distributions)"
fi
check_dep ffmpeg    ffmpeg   "media cannot be transcoded without it"
check_dep fusermount3 fuse3  "the Google Drive mount needs FUSE"
check_dep rclone    ""       "the Drive mount and transfer engine need it"
check_dep cloudflared ""     "the domain cannot reach this host without it"

if (( DO_INSTALL )) && ((${#need_apt[@]})); then
  apt_pkgs=()
  for p in "${need_apt[@]}"; do [[ -n "$p" ]] && apt_pkgs+=("$p"); done
  if ((${#apt_pkgs[@]})); then
    info "Installing: ${apt_pkgs[*]}  (sudo required)"
    sudo apt-get update -qq && sudo apt-get install -y "${apt_pkgs[@]}"
  fi
fi

# rclone and cloudflared are not in Debian/Ubuntu repos at usable versions;
# both ship a single static binary, installed per-user so no root is needed.
mkdir -p "$HOME/.local/bin"
if ! have rclone && (( DO_INSTALL )); then
  info "Installing rclone to ~/.local/bin"
  tmp="$(mktemp -d)"
  curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o "$tmp/r.zip" \
    && (cd "$tmp" && unzip -qo r.zip && cp rclone-*/rclone "$HOME/.local/bin/" && chmod +x "$HOME/.local/bin/rclone") \
    && ok "rclone installed" || bad "rclone install failed"
  rm -rf "$tmp"
fi
if ! have cloudflared && (( DO_INSTALL )); then
  info "Installing cloudflared to ~/.local/bin"
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
    -o "$HOME/.local/bin/cloudflared" && chmod +x "$HOME/.local/bin/cloudflared" \
    && ok "cloudflared installed" || bad "cloudflared install failed"
fi

# ── npm install ──────────────────────────────────────────────────────────────
echo
info "Node dependencies"
if [[ -d "$APP_DIR/node_modules" ]]; then
  ok "node_modules present"
else
  if (( DO_INSTALL )); then
    (cd "$APP_DIR" && npm ci --no-audit --no-fund) && ok "npm ci complete" || bad "npm ci failed"
  else
    warn "run: npm ci"
  fi
fi

# The frontend is NOT built here. The Vite sources were lost with the drive and
# dist/ is the committed, working build — running a build would replace it with
# a failed one. See amplify.yml for the same reasoning.
[[ -f "$APP_DIR/dist/index.html" ]] && ok "prebuilt frontend present (do not run vite build)" \
                                    || bad "dist/index.html missing — the repo clone is incomplete"

# ── systemd units ────────────────────────────────────────────────────────────
echo
info "Rendering systemd units for this machine"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR" "$HOME/.nexus-data/cloudflared" "$HOME/.config/rclone"

shopt -s nullglob
rendered=0
for t in "$APP_DIR"/deploy/systemd/*.service.template; do
  name="$(basename "$t" .template)"
  dst="$UNIT_DIR/$name"
  [[ -f "$dst" ]] && cp -p "$dst" "${dst}.pre-setup-$(date +%s)"
  sed -e "s#__APP_DIR__#${APP_DIR}#g" -e "s#__HOME__#${HOME}#g" "$t" > "$dst"
  ok "$name"
  rendered=$((rendered+1))
done
shopt -u nullglob
(( rendered > 0 )) || bad "no unit templates found in deploy/systemd/"
systemctl --user daemon-reload 2>/dev/null || true

# Services must survive logout, or the host dies when the session ends.
if command -v loginctl >/dev/null 2>&1; then
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == "yes" ]]; then
    ok "linger enabled (services survive logout)"
  else
    warn "linger is off — services stop at logout. Enable with:"
    echo "        sudo loginctl enable-linger $USER"
  fi
fi

# ── Secrets check ────────────────────────────────────────────────────────────
echo
info "Secrets (these come from the bundle, never from git)"
[[ -f "$APP_DIR/.env" ]]                      && ok ".env"                  || warn ".env missing — import the host bundle"
[[ -f "$HOME/.config/rclone/rclone.conf" ]]   && ok "rclone.conf"           || warn "rclone.conf missing — import the host bundle"
[[ -n "$(ls "$HOME"/.cloudflared/*.json 2>/dev/null)" ]] && ok "tunnel credential" \
                                                        || warn "tunnel credential missing — the domain will not reach this host"

if (( DO_START )); then
  echo
  info "Starting services"
  systemctl --user enable --now nexus-rclone-rcd.service nexus-cloud-media.service 2>/dev/null || true
  sleep 5
  systemctl --user enable --now nexus-host.service cloudflared-nexus.service 2>/dev/null || true
  sleep 10
  curl -fsS --max-time 15 http://127.0.0.1:3000/api/health >/dev/null 2>&1 \
    && ok "host responding on :3000" || warn "host not responding yet — check: journalctl --user -u nexus-host -n 50"
fi

cat <<EOF

$(printf '\033[36m==>\033[0m') Next

  1. Restore secrets (the only thing not in git):
       bash scripts/import-host-bundle.sh ~/savestate-host-bundle-*.tar.gz

  2. Make sure the OLD host has stopped serving — one tunnel run from two
     machines splits traffic between them:
       systemctl --user disable --now cloudflared-nexus nexus-host

  3. Start here:
       systemctl --user enable --now nexus-rclone-rcd nexus-cloud-media
       systemctl --user enable --now nexus-host cloudflared-nexus

  4. Verify:
       curl -s localhost:3000/api/health
       curl -s https://savestate.co.za/api/health/full | head -40
EOF
