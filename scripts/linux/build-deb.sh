#!/bin/sh
# Builds SaveState for Linux as a .deb (Ubuntu, Debian, Mint, Pop!_OS...):
# double-click it, or `sudo apt install ./savestate_<version>_amd64.deb`.
# The .sh installer (/api/client-launcher/linux-installer) opened as a text
# file when clicked on a laptop; a package installs like any other app.
#
#   sh scripts/linux/build-deb.sh [host-url]     (Linux/WSL with dpkg-deb, or Git Bash on
#                                                 Windows: then scripts/linux/pack-deb.mjs packs it)
#
# It holds the game launcher (client-launcher.cjs) and Node.js 22 from
# nodejs.org (checked against its published SHA-256), so nothing else has to
# be installed. Installs to /opt/savestate:
#   /usr/bin/savestate            opens SaveState in its own window and starts the launcher
#   /usr/bin/savestate-launcher   the launcher for the signed-in person, restarted if it stops
#   applications menu entry, and the launcher starts at every sign-in
# The launcher keeps its own files in ~/.local/share/NexusEmuClient, as the
# .sh install does. Writes releases/updates/savestate_<version>_amd64.deb.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOST_URL="${1:-https://savestate.co.za}"
VERSION=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
[ -n "$VERSION" ] || { echo "no version in package.json" >&2; exit 1; }
WORK=$(mktemp -d)
PKG="$WORK/pkg"
OUT="$ROOT/releases/updates/savestate_${VERSION}_amd64.deb"
trap 'rm -rf "$WORK"' EXIT

# ── Node.js, official build, checksum-verified ───────────────────────────
REL="https://nodejs.org/dist/latest-v22.x"
curl -fsSL "$REL/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
LINE=$(grep ' node-v[0-9.]*-linux-x64.tar.xz$' "$WORK/SHASUMS256.txt" | head -n 1)
[ -n "$LINE" ] || { echo "nodejs.org lists no linux-x64 build" >&2; exit 1; }
NODE_FILE=$(echo "$LINE" | awk '{print $2}')
curl -fsSL "$REL/$NODE_FILE" -o "$WORK/$NODE_FILE"
echo "$LINE" | (cd "$WORK" && sha256sum -c -) >/dev/null || { echo "Node.js checksum mismatch" >&2; exit 1; }
mkdir -p "$WORK/node"
tar -xJf "$WORK/$NODE_FILE" -C "$WORK/node" --strip-components=1

# ── Files ─────────────────────────────────────────────────────────────────
mkdir -p "$PKG/DEBIAN" "$PKG/opt/savestate/node/bin" "$PKG/usr/bin" "$PKG/usr/share/applications" \
  "$PKG/etc/xdg/autostart" "$PKG/usr/share/icons/hicolor/512x512/apps" "$PKG/usr/share/doc/savestate"
cp "$WORK/node/bin/node" "$PKG/opt/savestate/node/bin/node"
cp "$WORK/node/LICENSE" "$PKG/opt/savestate/node/LICENSE"
cp "$ROOT/client-launcher.cjs" "$PKG/opt/savestate/client-launcher.cjs"
printf '%s\n' "$HOST_URL" > "$PKG/opt/savestate/host-url"
printf '%s\n' "$VERSION" > "$PKG/opt/savestate/version"
cp "$ROOT/dist/pwa-512x512.png" "$PKG/usr/share/icons/hicolor/512x512/apps/savestate.png"
CHECK_NODE="$WORK/node/bin/node"; [ "$(uname -s)" = Linux ] || CHECK_NODE=node   # the Linux build can't run on Windows
"$CHECK_NODE" -e "new (require('vm').Script)(require('fs').readFileSync(process.argv[1],'utf8'))" "$PKG/opt/savestate/client-launcher.cjs"

cat > "$PKG/usr/bin/savestate-launcher" <<'EOF'
#!/bin/sh
# SaveState's game launcher for the signed-in person: lets Play in SaveState
# open games in emulators on this computer. One copy at a time; started again
# if it stops. Its files: ~/.local/share/NexusEmuClient (launcher.log there).
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/NexusEmuClient"
NODE=/opt/savestate/node/bin/node
mkdir -p "$DIR"
[ -s "$DIR/preferred-host-url.txt" ] || cp /opt/savestate/host-url "$DIR/preferred-host-url.txt"
exec 9>"$DIR/run.lock"
if command -v flock >/dev/null 2>&1; then flock -n 9 || exit 0; fi
up() { "$NODE" -e "require('http').get('http://127.0.0.1:17373/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; }
while :; do
  # Another copy (an older .sh install) already answering: leave it be.
  up || "$NODE" /opt/savestate/client-launcher.cjs >>"$DIR/launcher.log" 2>&1
  sleep 5
done
EOF

cat > "$PKG/usr/bin/savestate" <<'EOF'
#!/bin/sh
# Opens SaveState in its own window (a Chromium browser) or the default
# browser, and makes sure the game launcher is running.
URL=$(cat /opt/savestate/host-url 2>/dev/null || echo "https://savestate.co.za")
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/NexusEmuClient"
[ -s "$DIR/preferred-host-url.txt" ] && URL=$(cat "$DIR/preferred-host-url.txt")
nohup /usr/bin/savestate-launcher >/dev/null 2>&1 &
PROFILE="$DIR/app-profile"
mkdir -p "$PROFILE"
FLAGS="--app=$URL --user-data-dir=$PROFILE --class=SaveState --name=SaveState --unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:17373,http://127.0.0.1:17374 --enable-features=InsecurePrivateNetworkRequestsAllowed"
for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
  if command -v "$b" >/dev/null 2>&1; then exec "$b" $FLAGS; fi
done
exec xdg-open "$URL"
EOF
chmod 755 "$PKG/usr/bin/savestate" "$PKG/usr/bin/savestate-launcher" "$PKG/opt/savestate/node/bin/node"
chmod 644 "$PKG/opt/savestate/client-launcher.cjs" "$PKG/usr/share/icons/hicolor/512x512/apps/savestate.png"

cat > "$PKG/usr/share/applications/savestate.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=SaveState
Comment=Your games, films and music
Exec=/usr/bin/savestate
Icon=savestate
Categories=Game;AudioVideo;
Terminal=false
StartupNotify=true
EOF

cat > "$PKG/etc/xdg/autostart/savestate-launcher.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=SaveState launcher
Comment=Lets Play in SaveState open games on this computer
Exec=/usr/bin/savestate-launcher
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

cat > "$PKG/usr/share/doc/savestate/copyright" <<'EOF'
SaveState for Linux. Includes Node.js (https://nodejs.org), MIT licence:
see /opt/savestate/node/LICENSE.
EOF

INSTALLED_KB=$(du -sk "$PKG" | awk '{print $1}')
cat > "$PKG/DEBIAN/control" <<EOF
Package: savestate
Version: $VERSION
Architecture: amd64
Maintainer: SaveState <support@savestate.co.za>
Installed-Size: $INSTALLED_KB
Section: games
Priority: optional
Recommends: flatpak
Homepage: $HOST_URL
Description: SaveState for Linux
 Opens SaveState in its own window and installs the small game launcher
 that lets Play in SaveState start games in emulators on this computer
 (RetroArch, PCSX2, Dolphin, RPCS3...). After installing, open SaveState
 and choose Games > Set up games: it installs the emulators (Flathub).
EOF

# Stop the launcher before files change.
cat > "$PKG/DEBIAN/prerm" <<'EOF'
#!/bin/sh
pkill -f /usr/bin/savestate-launcher 2>/dev/null || true
pkill -f /opt/savestate/client-launcher.cjs 2>/dev/null || true
exit 0
EOF

# Start the launcher for whoever installed it, inside their desktop session
# (an emulator it opens needs that session's display). Otherwise it starts
# at the next sign-in, or when SaveState is opened from the menu.
cat > "$PKG/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
[ "$1" = "configure" ] || exit 0
u="${SUDO_USER:-}"
if [ -z "$u" ] && [ -n "${PKEXEC_UID:-}" ]; then u=$(getent passwd "$PKEXEC_UID" | cut -d: -f1); fi
if [ -z "$u" ] && command -v loginctl >/dev/null 2>&1; then
  set -- $(loginctl list-users --no-legend 2>/dev/null | awk '$1 >= 1000 {print $2}')
  [ $# -eq 1 ] && u="$1"
fi
[ -n "$u" ] && [ "$u" != root ] || exit 0
for p in $(pgrep -u "$u" 2>/dev/null); do
  envf="/proc/$p/environ"
  [ -r "$envf" ] || continue
  if tr '\0' '\n' < "$envf" | grep -q '^\(DISPLAY\|WAYLAND_DISPLAY\)='; then
    vars=$(tr '\0' '\n' < "$envf" | grep '^\(DISPLAY\|WAYLAND_DISPLAY\|XDG_RUNTIME_DIR\|DBUS_SESSION_BUS_ADDRESS\|XAUTHORITY\|HOME\|XDG_DATA_HOME\)=' | tr '\n' ' ')
    runuser -u "$u" -- env $vars sh -c 'nohup /usr/bin/savestate-launcher >/dev/null 2>&1 &' || true
    break
  fi
done
exit 0
EOF
chmod 755 "$PKG/DEBIAN/prerm" "$PKG/DEBIAN/postinst"

mkdir -p "$(dirname "$OUT")"
if command -v dpkg-deb >/dev/null 2>&1; then
  dpkg-deb --root-owner-group -Zxz --build "$PKG" "$OUT" >/dev/null
else
  # Windows (Git Bash) without WSL: pack it in Node, permissions set there.
  node "$ROOT/scripts/linux/pack-deb.mjs" "$PKG" "$OUT" >/dev/null
fi
echo "Built $OUT ($(du -h "$OUT" | awk '{print $1}')), $(basename "$NODE_FILE" .tar.xz)"
