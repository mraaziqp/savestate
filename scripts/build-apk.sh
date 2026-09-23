#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the Android TV / Fire TV APK.
#
#   ./scripts/build-apk.sh                      debug APK against savestate.co.za
#   NEXUS_APK_URL=http://192.168.1.50:3000 \
#     ./scripts/build-apk.sh                    LAN build, no tunnel dependency
#   ./scripts/build-apk.sh release              release APK (needs a keystore)
#
# The app is a thin client: it loads the live site rather than bundling a copy,
# so fixing something on the host fixes every TV box without re-sideloading.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-debug}"
# The Vite sources were lost with the media drive, so dist/ is prebuilt and
# checked in. If a real frontend build is ever restored, run it here first.
if [ -f vite.config.ts ] && npx --no-install vite --version >/dev/null 2>&1; then
  echo "==> Building frontend"
  npm run build
else
  echo "==> Skipping frontend build (Vite sources are not present; using the prebuilt dist/)"
fi
[ -f dist/index.html ] || { echo "dist/index.html missing — nothing to package"; exit 1; }

# Gradle needs a JDK; this host has one unpacked in the home directory rather
# than installed system-wide.
if [ -z "${JAVA_HOME:-}" ]; then
  for c in "$HOME/jdk-17.0.2" /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/default-java; do
    [ -x "$c/bin/java" ] && { export JAVA_HOME="$c"; break; }
  done
fi
[ -n "${JAVA_HOME:-}" ] || { echo "No JDK found. Set JAVA_HOME."; exit 1; }
export PATH="$JAVA_HOME/bin:$PATH"
echo "==> JAVA_HOME=$JAVA_HOME"

if [ -z "${ANDROID_HOME:-}" ]; then
  for c in "$HOME/android-sdk" "$HOME/Android/Sdk"; do
    [ -d "$c/platforms" ] && { export ANDROID_HOME="$c"; break; }
  done
fi
[ -n "${ANDROID_HOME:-}" ] || { echo "No Android SDK found. Set ANDROID_HOME."; exit 1; }
export ANDROID_SDK_ROOT="$ANDROID_HOME"
echo "==> ANDROID_HOME=$ANDROID_HOME"
# Gradle reads the SDK path from here, not the environment, on a clean checkout.
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > android/local.properties

echo "==> Target: ${NEXUS_APK_URL:-https://savestate.co.za}"
echo "==> Syncing web assets into the Android project"
npx cap sync android

echo "==> Assembling $MODE APK"
cd android
if [ "$MODE" = "release" ]; then
  ./gradlew --no-daemon assembleRelease
  OUT="app/build/outputs/apk/release/app-release-unsigned.apk"
  echo
  echo "Unsigned release APK: android/$OUT"
  echo "Sign it before installing:"
  echo "  \$ANDROID_HOME/build-tools/34.0.0/apksigner sign --ks my.keystore android/$OUT"
else
  ./gradlew --no-daemon assembleDebug
  OUT="app/build/outputs/apk/debug/app-debug.apk"
fi
cd ..

FULL="android/$OUT"
[ -f "$FULL" ] || { echo "Build reported success but $FULL is missing"; exit 1; }
echo
echo "APK: $(cd "$(dirname "$FULL")" && pwd)/$(basename "$FULL")"
echo "Size: $(du -h "$FULL" | cut -f1)"
echo
echo "Install on a TV box:"
echo "  adb connect <tv-ip>:5555"
echo "  adb install -r $FULL"
