#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Restore a savestate host bundle onto THIS machine.
#
# Run it on the new host after cloning the repo and running `npm ci`.
#
#   scripts/import-host-bundle.sh savestate-host-bundle-YYYYmmdd-HHMMSS.tar.gz
#
# IMPORTANT — the tunnel is single-occupancy in practice. Cloudflare will
# happily let two machines run the same tunnel and will load-balance between
# them, which looks like a host that randomly serves half-empty libraries.
# Stop the services on the OLD machine before starting them here:
#
#   systemctl --user stop cloudflared-nexus nexus-host
#   systemctl --user disable cloudflared-nexus nexus-host
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BUNDLE="${1:-}"
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || { echo "Usage: $0 <bundle.tar.gz[.gpg]>" >&2; exit 1; }

APP_DIR="${NEXUS_APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${NEXUS_DATA_DIR:-$HOME/.nexus-data}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

ok()   { printf '\033[32m  ok\033[0m   %s\n' "$*"; }
warn() { printf '\033[33m  --\033[0m   %s\n' "$*"; }
bad()  { printf '\033[31m  !!\033[0m   %s\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

if [[ "$BUNDLE" == *.gpg ]]; then
  command -v gpg >/dev/null || { bad "gpg needed to decrypt this bundle"; exit 1; }
  info "Decrypting"
  gpg -o "$STAGE/bundle.tar.gz" -d "$BUNDLE" || { bad "decryption failed"; exit 1; }
  BUNDLE="$STAGE/bundle.tar.gz"
fi

tar -xzf "$BUNDLE" -C "$STAGE" || { bad "could not extract bundle"; exit 1; }
B="$STAGE/bundle"
[[ -d "$B" ]] || { bad "bundle layout unexpected"; exit 1; }

echo; cat "$B/MANIFEST.txt" 2>/dev/null; echo

info "Restoring into $APP_DIR and $DATA_DIR"
mkdir -p "$DATA_DIR" "$HOME/.cloudflared" "$HOME/.config/rclone" \
         "$DATA_DIR/cloudflared" "$HOME/.config/systemd/user"

# Never clobber an existing file silently — back it up first, since a wrong
# restore over a working host is much worse than a refused one.
place() {
  local src="$1" dst="$2"
  [[ -f "$src" ]] || return 0
  if [[ -f "$dst" ]]; then
    cp -p "$dst" "${dst}.pre-import-$(date +%s)" 2>/dev/null || true
  fi
  install -m 600 "$src" "$dst" && ok "$(basename "$dst")"
}

# Tunnel — this is what carries the domain.
shopt -s nullglob
for f in "$B"/cloudflared/*.json; do place "$f" "$HOME/.cloudflared/$(basename "$f")"; done
shopt -u nullglob
place "$B/cloudflared/config.yml" "$DATA_DIR/cloudflared/config.yml"

# rclone (Drive)
place "$B/rclone/rclone.conf" "$HOME/.config/rclone/rclone.conf"

# App env
place "$B/env/.env" "$APP_DIR/.env"
place "$B/env/.env.production" "$APP_DIR/.env.production"

# App state
shopt -s nullglob
for f in "$B"/state/*.json; do place "$f" "$DATA_DIR/$(basename "$f")"; done
shopt -u nullglob

# systemd units — paths inside may reference the old home directory.
if compgen -G "$B/systemd/*.service" > /dev/null; then
  for f in "$B"/systemd/*.service; do
    dst="$HOME/.config/systemd/user/$(basename "$f")"
    [[ -f "$dst" ]] && cp -p "$dst" "${dst}.pre-import-$(date +%s)"
    # Rewrite the old home path if this machine's user differs.
    sed "s#/home/moh#${HOME}#g" "$f" > "$dst" && ok "unit: $(basename "$f")"
  done
  systemctl --user daemon-reload 2>/dev/null || true
fi

echo
info "Checks"
command -v node >/dev/null && ok "node $(node --version)" || bad "node not installed"
command -v ffmpeg >/dev/null && ok "ffmpeg present" || bad "ffmpeg missing — media will not transcode"
command -v rclone >/dev/null && ok "rclone present" || bad "rclone missing — Drive mount will not work"
command -v cloudflared >/dev/null && ok "cloudflared present" || bad "cloudflared missing — the domain will not reach this host"
[[ -d "$APP_DIR/node_modules" ]] && ok "node_modules present" || warn "run: npm ci"
[[ -e /dev/dri/renderD128 ]] && ok "VAAPI render node present" || warn "no /dev/dri — software transcoding only (slower)"

cat <<EOF

$(printf '\033[36m==>\033[0m') Next

  1. On the OLD machine, stop it serving (two hosts on one tunnel split traffic):
       systemctl --user stop cloudflared-nexus nexus-host
       systemctl --user disable cloudflared-nexus nexus-host

  2. Here, start the stack:
       systemctl --user enable --now nexus-rclone-rcd nexus-cloud-media
       systemctl --user enable --now nexus-host cloudflared-nexus

  3. Verify:
       curl -s localhost:3000/api/health
       curl -s https://savestate.co.za/api/health/full

  If the Drive mount is empty, re-authorise rclone:  rclone config reconnect gdrive:
EOF
