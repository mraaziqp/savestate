#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Set up SaveState on a NAS or any Linux machine with Docker.
#
#   curl -fsSL https://savestate.co.za/install.sh | bash
#
# Asks where your films, music and games are, then runs SaveState and its own
# database in Docker (deploy/nas/docker-compose.yml). Your folders are mounted
# read-only. Run it again to update: settings and passwords are kept.
#
# Without questions (for scripts):
#   SAVESTATE_DIR=/volume1/docker/savestate MEDIA_DIR=/volume1/video \
#   MUSIC_DIR=/volume1/music GAMES_DIR=/volume1/games PORT=3000 \
#   SAVESTATE_YES=1 bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="https://github.com/mraaziqp/savestate"
BRANCH="${SAVESTATE_BRANCH:-main}"
DIR="${SAVESTATE_DIR:-$HOME/savestate}"

say()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m  %s\n' "$*"; }
warn() { printf '\033[33m  !!\033[0m  %s\n' "$*"; }
die()  { printf '\033[31m  !!\033[0m  %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Piped into bash, stdin is this script: questions read from the terminal.
ask() {
  local prompt="$1" default="$2" answer=""
  if [[ -n "${SAVESTATE_YES:-}" || ! -r /dev/tty ]]; then echo "$default"; return; fi
  read -r -p "$prompt [$default]: " answer </dev/tty || true
  echo "${answer:-$default}"
}

say "SaveState installer"

# ── Docker ───────────────────────────────────────────────────────────────────
SUDO=""
if ! have docker; then
  warn "Docker isn't installed."
  echo "      Synology: Package Center > Container Manager.  QNAP: Container Station."
  echo "      Unraid / TrueNAS: Docker is built in (enable it in Settings / Apps)."
  echo "      Ubuntu / Debian / Raspberry Pi OS: curl -fsSL https://get.docker.com | sh"
  die "Install Docker, then run this again."
fi
if ! docker info >/dev/null 2>&1; then
  if have sudo && sudo -n docker info >/dev/null 2>&1; then SUDO="sudo"
  elif have sudo; then say "Docker needs administrator rights here; you may be asked for your password."; SUDO="sudo"
  else die "Docker is installed but not running, or this user can't use it. Start Docker (or run as root) and try again."; fi
fi
if $SUDO docker compose version >/dev/null 2>&1; then COMPOSE=($SUDO docker compose)
elif have docker-compose; then COMPOSE=($SUDO docker-compose)
else die "Docker Compose is missing. Install the docker compose plugin and try again."; fi
ok "Docker $($SUDO docker version --format '{{.Server.Version}}' 2>/dev/null || echo ready)"

# ── The code ─────────────────────────────────────────────────────────────────
if [[ -d "$DIR/.git" ]] && have git; then
  say "Updating $DIR"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH" && git -C "$DIR" reset --hard "origin/$BRANCH"
else
  say "Downloading SaveState to $DIR"
  mkdir -p "$DIR"
  if have git; then
    tmp="$(mktemp -d)"; git clone --depth 1 -b "$BRANCH" "$REPO.git" "$tmp/src"
    cp -a "$tmp/src/." "$DIR/"; rm -rf "$tmp"
  else
    curl -fsSL "$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz --strip-components=1 -C "$DIR"
  fi
fi
ok "code in $DIR"

# ── Settings (kept between runs) ─────────────────────────────────────────────
NAS="$DIR/deploy/nas"
ENV="$NAS/.env"
mkdir -p "$NAS/empty"
get() { [[ -f "$ENV" ]] && grep -E "^$1=" "$ENV" | tail -1 | cut -d= -f2- || true; }
rand() { od -An -tx1 -N48 /dev/urandom | tr -d ' \n' | cut -c1-"$1"; }
guess() { for d in "$@"; do [[ -d "$d" ]] && { echo "$d"; return; }; done; echo ""; }

DB_PASSWORD="$(get DB_PASSWORD)"; DB_PASSWORD="${DB_PASSWORD:-$(rand 32)}"
JWT_SECRET="$(get JWT_SECRET)";   JWT_SECRET="${JWT_SECRET:-$(rand 64)}"
MEDIA_DIR="${MEDIA_DIR:-$(get MEDIA_DIR)}"; MEDIA_DIR="${MEDIA_DIR:-$(guess /volume1/video /volume1/Media /mnt/user/media /mnt/media /srv/media "$HOME/Videos")}"
MUSIC_DIR="${MUSIC_DIR:-$(get MUSIC_DIR)}"; MUSIC_DIR="${MUSIC_DIR:-$(guess /volume1/music /mnt/user/music /mnt/music /srv/music "$HOME/Music")}"
GAMES_DIR="${GAMES_DIR:-$(get GAMES_DIR)}"; GAMES_DIR="${GAMES_DIR:-$(guess /volume1/games /volume1/roms /mnt/user/games /mnt/games /srv/roms "$HOME/roms")}"
PORT="${PORT:-$(get PORT)}"; PORT="${PORT:-3000}"

echo
echo "Where are your files? (leave blank to add them later; folders are never changed)"
MEDIA_DIR="$(ask "  Films & shows folder" "$MEDIA_DIR")"
MUSIC_DIR="$(ask "  Music folder" "$MUSIC_DIR")"
GAMES_DIR="$(ask "  Games (ROMs) folder" "$GAMES_DIR")"
PORT="$(ask "  Port for the web app" "$PORT")"
for v in MEDIA_DIR MUSIC_DIR GAMES_DIR; do
  p="${!v}"
  if [[ -n "$p" && ! -d "$p" ]]; then warn "$p doesn't exist; leaving it out"; printf -v "$v" '%s' ""; fi
done

umask 077
cat >"$ENV" <<EOF
# Written by install.sh. Keep it private: it holds this host's passwords.
DB_PASSWORD=$DB_PASSWORD
JWT_SECRET=$JWT_SECRET
MEDIA_DIR=${MEDIA_DIR:-./empty}
MUSIC_DIR=${MUSIC_DIR:-./empty}
GAMES_DIR=${GAMES_DIR:-./empty}
PORT=$PORT
EOF
umask 022
ok "settings in $ENV"

# ── Start ────────────────────────────────────────────────────────────────────
say "Building and starting (the first time takes a few minutes)"
cd "$NAS"
"${COMPOSE[@]}" up -d --build

say "Waiting for SaveState to answer"
for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
  [[ $i -eq 90 ]] && { "${COMPOSE[@]}" logs --tail 40 app; die "It didn't start. The log above says why; run this again after fixing it."; }
done
ok "running"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; IP="${IP:-localhost}"
echo
printf '\033[32mSaveState is ready:\033[0m  http://%s:%s\n' "$IP" "$PORT"
echo
echo "  1. Open that address and create your account: the first account owns this host."
echo "  2. Movies & TV, Music and Games find the folders you chose (scan from each page)."
echo "  3. To reach it from outside your home, see Help & guides > Hosting on a NAS."
echo
echo "  Update later:  curl -fsSL https://savestate.co.za/install.sh | bash"
echo "  Stop:          cd $NAS && ${COMPOSE[*]} down"
