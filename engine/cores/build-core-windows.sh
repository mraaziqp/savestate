#!/usr/bin/env bash
# Builds SaveState's own Windows (x86_64) copies of libretro cores from their
# official sources, the Windows side of build-core.ps1 (Android). Runs in
# MSYS2's MINGW64 shell (gcc, make, cmake, ninja from pacman). Sources are
# cloned into G:\Projects\savestate-cores-win (outside the repository: big);
# finished cores land in releases/cores/windows/x86_64/<core>_libretro.dll.zip
# with a cores.json beside them (sha256, source commit), which the host serves
# ahead of libretro's buildbot (/api/emulator/native-core/windows/x86_64/...).
#
#   C:\msys64\usr\bin\env.exe MSYSTEM=MINGW64 CHERE_INVOKING=1 /usr/bin/bash -l engine/cores/build-core-windows.sh fceumm snes9x
set -u
# MSYS2's login shell has its own PATH: Node.js (for cores.json) is added.
export PATH="$PATH:/c/Program Files/nodejs"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SRC=/g/Projects/savestate-cores-win
# CORES_OUT: build somewhere else first (a staging folder) and publish a core
# only after it has played a real game; this folder is what the host serves.
OUT="${CORES_OUT:-$REPO/releases/cores/windows/x86_64}"
if [ "${1:-}" = "--staging" ]; then OUT="$REPO/releases/cores-staging/windows/x86_64"; shift; fi
LOGS="$SRC/logs"
JOBS=$(( $(nproc) > 2 ? $(nproc) - 2 : 1 ))   # leave the PC room for the server and games
mkdir -p "$SRC" "$OUT" "$LOGS"

# core | repository | build directory | build command | built file (relative to the build directory)
spec() {
  case "$1" in
    fceumm)          echo "https://github.com/libretro/libretro-fceumm.git|.|make -f Makefile.libretro platform=win|fceumm_libretro.dll" ;;
    snes9x)          echo "https://github.com/libretro/snes9x.git|libretro|make platform=win|snes9x_libretro.dll" ;;
    genesis_plus_gx) echo "https://github.com/libretro/Genesis-Plus-GX.git|.|make -f Makefile.libretro platform=win|genesis_plus_gx_libretro.dll" ;;
    picodrive)       echo "https://github.com/libretro/picodrive.git|.|make -f Makefile.libretro platform=win|picodrive_libretro.dll" ;;
    pcsx_rearmed)    echo "https://github.com/libretro/pcsx_rearmed.git|.|make -f Makefile.libretro platform=win|pcsx_rearmed_libretro.dll" ;;
    gambatte)        echo "https://github.com/libretro/gambatte-libretro.git|.|make platform=win|gambatte_libretro.dll" ;;
    stella)          echo "https://github.com/stella-emu/stella.git|src/os/libretro|make platform=win|stella_libretro.dll" ;;
    fbneo)           echo "https://github.com/libretro/FBNeo.git|src/burner/libretro|make platform=win|fbneo_libretro.dll" ;;
    # The libretro makefile: mGBA's CMake build insists on libepoxy on Windows.
    mgba)            echo "https://github.com/libretro/mgba.git|.|make -f Makefile.libretro platform=win|mgba_libretro.dll" ;;
    mupen64plus_next) echo "https://github.com/libretro/mupen64plus-libretro-nx.git|.|make platform=win|mupen64plus_next_libretro.dll" ;;
    ppsspp)          echo "https://github.com/hrydgard/ppsspp.git|.|cmake -G Ninja -B build-win -DCMAKE_BUILD_TYPE=Release -DLIBRETRO=ON && cmake --build build-win --target ppsspp_libretro -j JOBS|build-win/lib/ppsspp_libretro.dll" ;;
    flycast)         echo "https://github.com/flyinghead/flycast.git|.|cmake -G Ninja -B build-win -DCMAKE_BUILD_TYPE=Release -DLIBRETRO=ON -DUSE_HOST_LIBZIP=OFF -DUSE_LUA=OFF -DUSE_BREAKPAD=OFF && cmake --build build-win --target flycast_libretro -j JOBS|build-win/flycast_libretro.dll" ;;
    melondsds)       echo "https://github.com/JesseTG/melonds-ds.git|.|cmake -G Ninja -B build-win -DCMAKE_BUILD_TYPE=Release && cmake --build build-win -j JOBS|build-win/src/libretro/melondsds_libretro.dll" ;;
    *) return 1 ;;
  esac
}

build() {
  local core="$1" s repo dir cmd lib
  s="$(spec "$core")" || { echo "$core: no recipe"; return 1; }
  IFS='|' read -r repo dir cmd lib <<< "$s"
  local tree="$SRC/$core" log="$LOGS/$core.log"
  if [ ! -d "$tree/.git" ]; then
    echo "$core: cloning $repo"
    git clone --depth 1 --recursive --shallow-submodules "$repo" "$tree" > "$log" 2>&1 || { echo "$core: clone failed (see $log)"; return 1; }
  fi
  local commit; commit="$(git -C "$tree" rev-parse --short HEAD)"
  echo "$core: building $commit"
  local t0=$SECONDS
  # A fresh link and configure every time (so the link flags above apply).
  rm -f "$tree/$dir/$lib" "$tree/$dir/build-win/CMakeCache.txt"
  # (make cores get -j from MAKEFLAGS; cmake ones from JOBS in their command)
  ( cd "$tree/$dir" && eval "${cmd//JOBS/$JOBS}" ) >> "$log" 2>&1 || true
  if [ ! -f "$tree/$dir/$lib" ]; then echo "$core: FAILED after $((SECONDS - t0))s (tail of $log):"; tail -n 15 "$log"; return 1; fi
  local dll="$tree/$dir/$lib" name="${core}_libretro.dll"
  # Only the system DLLs every Windows has, so the core runs on any PC.
  local deps; deps="$(objdump -p "$dll" | sed -n 's/^\s*DLL Name: //p' | tr 'A-Z' 'a-z' | sort -u | grep -viE '^(kernel32|user32|gdi32|winmm|ole32|oleaut32|shell32|advapi32|ws2_32|opengl32|dsound|dinput8|xinput1_4|xinput9_1_0|comdlg32|shlwapi|version|msvcrt|ucrtbase|api-ms-win-.*|bcrypt|setupapi|hid|imm32|dxgi|d3d11|d3d12|d3dcompiler_47|uxtheme|dwmapi|iphlpapi|psapi|crypt32|secur32|ntdll|vulkan-1|mfplat|mfreadwrite|mf|propsys|avrt|cfgmgr32|dbghelp|userenv|wtsapi32|rpcrt4|comctl32|powrprof|netapi32|mpr|winhttp|mswsock)\.dll$' || true)"
  if [ -n "$deps" ]; then echo "$core: needs DLLs other PCs won't have: $(echo $deps)"; return 1; fi
  strip -s -o "$OUT/$name" "$dll"
  ( cd "$OUT" && rm -f "$name.zip" && zip -q -9 "$name.zip" "$name" && rm -f "$name" )
  local sha size; sha="$(sha256sum "$OUT/$name.zip" | cut -d' ' -f1)"; size="$(stat -c %s "$OUT/$name.zip")"
  node -e '
    const fs = require("fs"), f = process.argv[1];
    const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    j[process.argv[2]] = { file: process.argv[3], sha256: process.argv[4], size: +process.argv[5], source: process.argv[6], commit: process.argv[7], builtAt: new Date().toISOString() };
    fs.writeFileSync(f, JSON.stringify(j, null, 2));
  ' "$OUT/cores.json" "$core" "$name.zip" "$sha" "$size" "$repo" "$commit"
  echo "$core: OK in $((SECONDS - t0))s ($((size / 1024)) KB zipped)"
}

command -v zip >/dev/null || pacman -S --noconfirm --needed zip unzip > /dev/null 2>&1
export MAKEFLAGS="-j$JOBS"
# MinGW's own runtime (winpthread, libgcc, libstdc++) linked into each core:
# as separate DLLs they aren't on other PCs, and the core wouldn't load there.
export LDFLAGS="${LDFLAGS:-} -static -static-libgcc -static-libstdc++"
export CMAKE_SHARED_LINKER_FLAGS="-static -static-libgcc -static-libstdc++"
status=0
for core in "$@"; do build "$core" || status=1; done
exit $status
