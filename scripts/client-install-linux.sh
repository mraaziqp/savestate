#!/bin/sh
# SaveState for Linux: the small game launcher that lets Play in SaveState
# open games in real emulators on this computer (RetroArch, PCSX2, Dolphin,
# RPCS3...), the same job SaveState for Windows does.
#
#   curl -fsSL https://savestate.co.za/api/client-launcher/linux-installer | sh
#
# What it does, all inside your home folder (no sudo):
#   1. Node.js 18 or newer: the one already installed, or the official build
#      from nodejs.org (checked against its published SHA-256).
#   2. The launcher, from this SaveState host.
#   3. Starts it now and every time you sign in (desktop autostart), and keeps
#      it running if it stops.
#   4. A "SaveState" entry in your applications menu.
# Then "Set up games" in SaveState installs the emulators (Flathub) and cores.
#
# Remove it: sh ~/.local/share/NexusEmuClient/uninstall.sh
set -eu

BASE_URL="${SAVESTATE_URL:-__BASE_URL__}"
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/NexusEmuClient"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
PORT=17373

say() { printf '\033[1;36m[SaveState]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[SaveState]\033[0m %s\n' "$*" >&2; exit 1; }
get() { # get URL FILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else fail "Neither curl nor wget is installed. Install one (for example: sudo apt install curl) and run this again."; fi
}
show() { # show URL (to stdout)
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 "$1"; else wget -q -O - "$1"; fi
}
healthy() { show "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true'; }

[ "$(uname -s)" = "Linux" ] || fail "This installer is for Linux. On Windows, download SaveState for Windows from the app instead."
mkdir -p "$DIR" "$APPS" "$AUTOSTART"

# ── 1. Node.js ────────────────────────────────────────────────────────────
NODE=""
for n in "$DIR/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$n" ] && [ -x "$n" ]; then
    major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$major" -ge 18 ] 2>/dev/null; then NODE="$n"; break; fi
  fi
done
if [ -z "$NODE" ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l|armv7*) arch=armv7l ;;
    *) fail "This computer's processor ($(uname -m)) has no Node.js build. Install Node.js 18+ with your package manager and run this again." ;;
  esac
  say "Getting Node.js (once, into $DIR/node)..."
  rel="https://nodejs.org/dist/latest-v22.x"
  sums=$(show "$rel/SHASUMS256.txt") || fail "Couldn't reach nodejs.org. Check the connection and run this again."
  line=$(printf '%s\n' "$sums" | grep " node-v[0-9.]*-linux-$arch.tar.gz\$" | head -n 1)
  [ -n "$line" ] || fail "nodejs.org has no Node.js for linux-$arch."
  want=$(printf '%s' "$line" | awk '{print $1}')
  file=$(printf '%s' "$line" | awk '{print $2}')
  tmp=$(mktemp -d)
  get "$rel/$file" "$tmp/$file"
  got=$( (sha256sum "$tmp/$file" 2>/dev/null || shasum -a 256 "$tmp/$file") | awk '{print $1}')
  [ "$got" = "$want" ] || { rm -rf "$tmp"; fail "The Node.js download didn't match its published checksum. Run this again."; }
  rm -rf "$DIR/node" && mkdir -p "$DIR/node"
  tar -xzf "$tmp/$file" -C "$DIR/node" --strip-components=1
  rm -rf "$tmp"
  NODE="$DIR/node/bin/node"
fi
say "Node.js $("$NODE" -v)"

# ── 2. The launcher ───────────────────────────────────────────────────────
say "Downloading the SaveState launcher from $BASE_URL ..."
get "$BASE_URL/api/client-launcher/cjs" "$DIR/client-launcher.cjs.new"
"$NODE" -e "new (require('vm').Script)(require('fs').readFileSync(process.argv[1],'utf8'))" "$DIR/client-launcher.cjs.new" \
  || fail "The launcher download is incomplete. Run this again."
mv -f "$DIR/client-launcher.cjs.new" "$DIR/client-launcher.cjs"
printf '%s\n' "$BASE_URL" > "$DIR/preferred-host-url.txt"

# Keeps it running: starts it again if it stops (crash, update).
cat > "$DIR/run.sh" <<EOF
#!/bin/sh
# Started at sign-in (autostart); one copy at a time.
exec 9>"$DIR/run.lock"
if command -v flock >/dev/null 2>&1; then flock -n 9 || exit 0; fi
while :; do
  if ! (command -v curl >/dev/null 2>&1 && curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1); then
    "$NODE" "$DIR/client-launcher.cjs" >>"$DIR/launcher.log" 2>&1
  fi
  sleep 5
done
EOF
chmod +x "$DIR/run.sh"

# ── 3. Start now and at every sign-in ─────────────────────────────────────
cat > "$AUTOSTART/savestate-launcher.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SaveState launcher
Comment=Lets Play in SaveState open games on this computer
Exec=sh "$DIR/run.sh"
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

# Stop an older copy so the new one takes over.
pkill -f "$DIR/client-launcher.cjs" 2>/dev/null || true
pkill -f "$DIR/run.sh" 2>/dev/null || true
sleep 1
nohup sh "$DIR/run.sh" >/dev/null 2>&1 &

# ── 4. The menu entry ─────────────────────────────────────────────────────
get "$BASE_URL/pwa-512x512.png" "$DIR/savestate.png" 2>/dev/null || true
cat > "$DIR/open.sh" <<EOF
#!/bin/sh
# Opens SaveState in its own window when a Chromium browser is installed.
for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
  if command -v "\$b" >/dev/null 2>&1; then exec "\$b" --app="$BASE_URL"; fi
done
exec xdg-open "$BASE_URL"
EOF
chmod +x "$DIR/open.sh"
cat > "$APPS/savestate.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SaveState
Comment=Your games, films and music
Exec=sh "$DIR/open.sh"
Icon=$DIR/savestate.png
Categories=Game;AudioVideo;
Terminal=false
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true

cat > "$DIR/uninstall.sh" <<EOF
#!/bin/sh
# Removes SaveState's launcher (emulators, games and saves stay).
pkill -f "$DIR/run.sh" 2>/dev/null; pkill -f "$DIR/client-launcher.cjs" 2>/dev/null
rm -f "$AUTOSTART/savestate-launcher.desktop" "$APPS/savestate.desktop"
rm -rf "$DIR/node" "$DIR/client-launcher.cjs" "$DIR/run.sh" "$DIR/open.sh" "$DIR/savestate.png" "$DIR/uninstall.sh"
echo "SaveState's launcher is removed."
EOF
chmod +x "$DIR/uninstall.sh"

# ── Done? ─────────────────────────────────────────────────────────────────
i=0
while [ $i -lt 20 ]; do
  if healthy; then
    say "Installed and running. Back in SaveState, open Games > Set up games: it installs the emulators and finishes the rest."
    command -v flatpak >/dev/null 2>&1 || say "Tip: install Flatpak (flatpak.org/setup) so Set up games can add PS2, GameCube and PS3 emulators by itself."
    exit 0
  fi
  i=$((i + 1)); sleep 1
done
say "Installed. The launcher is still starting; if Set up games can't find it, see $DIR/launcher.log."
