#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Export everything that makes THIS machine the savestate.co.za host, so it can
# be restored on another machine.
#
# What actually makes a host:
#   * the Cloudflare tunnel credential — whichever machine runs cloudflared
#     with this file receives the domain's traffic. This is the one piece that
#     cannot be regenerated from the repo.
#   * the rclone config — the Google Drive token the media/ROM mount uses.
#   * .env / .env.production — DB URL, JWT secret, Drive service-account key.
#   * .nexus-data/*.json — library index, watch progress, host state.
#
# What is deliberately NOT included:
#   * media and ROMs — those live on Google Drive already; copying 100 GB into
#     a tarball would defeat the point of the migration.
#   * the HLS cache — regenerable, and it reached 37 GB once.
#   * node_modules / dist — reinstall and pull from git instead.
#
# THE BUNDLE CONTAINS SECRETS IN PLAINTEXT. It is written with mode 600 and
# must move over something private (USB, scp), never a chat or cloud share.
# Pass --encrypt to wrap it in a passphrase-protected archive instead.
#
#   scripts/export-host-bundle.sh [--encrypt] [--out DIR]
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

OUT_DIR="${HOME}"
ENCRYPT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --encrypt) ENCRYPT=1 ;;
    --out) OUT_DIR="${2:-$OUT_DIR}"; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

APP_DIR="${NEXUS_APP_DIR:-/home/moh/NexussEmu}"
DATA_DIR="${NEXUS_DATA_DIR:-/home/moh/.nexus-data}"
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

ok()   { printf '\033[32m  ok\033[0m   %s\n' "$*"; }
warn() { printf '\033[33m  --\033[0m   %s\n' "$*"; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

info "Staging host bundle"
mkdir -p "$STAGE/bundle"/{cloudflared,rclone,env,state,systemd}

# ── Cloudflare tunnel ────────────────────────────────────────────────────────
# Only the tunnel this host actually serves — there are several credential
# files here for unrelated tunnels and they should not travel.
TUNNEL_CFG="$DATA_DIR/cloudflared/config.yml"
if [[ -f "$TUNNEL_CFG" ]]; then
  cp "$TUNNEL_CFG" "$STAGE/bundle/cloudflared/config.yml"
  TUNNEL_ID="$(grep -oP '^tunnel:\s*\K\S+' "$TUNNEL_CFG" 2>/dev/null || true)"
  if [[ -n "${TUNNEL_ID:-}" && -f "$HOME/.cloudflared/${TUNNEL_ID}.json" ]]; then
    cp "$HOME/.cloudflared/${TUNNEL_ID}.json" "$STAGE/bundle/cloudflared/"
    ok "tunnel credential ($TUNNEL_ID)"
  else
    warn "tunnel id found but no credential file — the domain will NOT follow"
  fi
else
  warn "no tunnel config at $TUNNEL_CFG"
fi

# ── rclone (Google Drive) ────────────────────────────────────────────────────
if [[ -f "$HOME/.config/rclone/rclone.conf" ]]; then
  cp "$HOME/.config/rclone/rclone.conf" "$STAGE/bundle/rclone/"
  ok "rclone config (Drive token)"
else
  warn "no rclone config — the Drive mount will need re-authorising"
fi

# ── App env ──────────────────────────────────────────────────────────────────
for f in .env .env.production; do
  [[ -f "$APP_DIR/$f" ]] && { cp "$APP_DIR/$f" "$STAGE/bundle/env/"; ok "$f"; }
done

# ── App state (small JSON only; never the caches) ────────────────────────────
shopt -s nullglob
for f in "$DATA_DIR"/*.json; do
  cp "$f" "$STAGE/bundle/state/" 2>/dev/null && ok "state: $(basename "$f")"
done
shopt -u nullglob

# ── systemd units that constitute the host ───────────────────────────────────
for u in nexus-host cloudflared-nexus nexus-cloud-media nexus-rclone-rcd nexus-client-launcher; do
  src="$HOME/.config/systemd/user/${u}.service"
  [[ -f "$src" ]] && { cp "$src" "$STAGE/bundle/systemd/"; ok "unit: ${u}.service"; }
done

# ── Manifest, so the far end knows what it received ──────────────────────────
{
  echo "savestate host bundle"
  echo "exported:   $(date -Is)"
  echo "from host:  $(hostname)"
  echo "app dir:    $APP_DIR"
  echo "git commit: $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "tunnel id:  ${TUNNEL_ID:-none}"
  echo
  echo "Restore with: scripts/import-host-bundle.sh <this-file>"
  echo
  echo "NOT included (by design): media, ROMs, HLS cache, node_modules, dist."
  echo "Media and ROMs live on Google Drive and are mounted by rclone."
} > "$STAGE/bundle/MANIFEST.txt"

TARBALL="$OUT_DIR/savestate-host-bundle-$STAMP.tar.gz"
tar -czf "$TARBALL" -C "$STAGE" bundle
chmod 600 "$TARBALL"

if (( ENCRYPT )); then
  if command -v gpg >/dev/null 2>&1; then
    info "Encrypting (you will be asked for a passphrase twice)"
    gpg --symmetric --cipher-algo AES256 -o "${TARBALL}.gpg" "$TARBALL" && rm -f "$TARBALL"
    TARBALL="${TARBALL}.gpg"
    chmod 600 "$TARBALL"
  else
    warn "gpg not installed — leaving the bundle unencrypted"
  fi
fi

echo
info "Bundle: $TARBALL  ($(du -h "$TARBALL" | cut -f1))"
echo
echo "  Move it over something private (USB or scp), not chat or cloud storage."
echo "  It contains the tunnel credential, the Drive token and your app secrets."
echo
echo "  On the new machine:"
echo "    git clone git@github.com:mraaziqp/savestate.git NexussEmu"
echo "    cd NexussEmu && npm ci"
echo "    scripts/import-host-bundle.sh $(basename "$TARBALL")"
