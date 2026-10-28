# Builds SaveState's own copies of libretro cores for Android (arm64) from
# their official sources (Phase 7, SAVESTATE_ENGINE_SPEC.md 14). Sources are
# cloned into G:\Projects\savestate-cores (outside the repository: they're big);
# finished cores land in releases\cores\android\<core>_libretro_android.so
# (arm64-v8a), which the host serves to the SaveState app (/api/engine/android/*).
#
#   powershell -File engine\cores\build-core.ps1 gambatte
#   powershell -File engine\cores\build-core.ps1 ppsspp
param([Parameter(Mandatory)][string]$Core)
$ErrorActionPreference = 'Stop'
$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$Ndk = "$Sdk\ndk\27.3.13750724"
$CMakeBin = "$Sdk\cmake\3.31.6\bin"
$Src = 'G:\Projects\savestate-cores'
$Out = Join-Path $PSScriptRoot '..\..\releases\cores\android'   # served by the host; releases/ stays out of git
New-Item -ItemType Directory -Force $Src, $Out | Out-Null

# Each core: its official repository and how it builds for Android.
$cores = @{
  gambatte = @{ repo = 'https://github.com/libretro/gambatte-libretro.git'; kind = 'ndk'; jni = 'libgambatte\libretro\jni'; lib = 'libgambatte\libretro\libs\arm64-v8a\libretro.so' }
  mgba     = @{ repo = 'https://github.com/libretro/mgba.git';              kind = 'cmake'; target = 'mgba_libretro'; lib = 'build-android\mgba_libretro.so'; flags = @('-DBUILD_LIBRETRO=ON', '-DBUILD_QT=OFF', '-DBUILD_SDL=OFF', '-DBUILD_SHARED=OFF', '-DBUILD_STATIC=OFF', '-DUSE_FFMPEG=OFF', '-DUSE_SQLITE3=OFF', '-DUSE_ELF=OFF', '-DUSE_DISCORD_RPC=OFF', '-DUSE_LUA=OFF', '-DUSE_JSON_C=OFF', '-DUSE_EDITLINE=OFF', '-DUSE_LIBZIP=OFF', '-DUSE_PNG=OFF') }
  snes9x   = @{ repo = 'https://github.com/libretro/snes9x.git';           kind = 'ndk'; jni = 'libretro\jni';               lib = 'libretro\libs\arm64-v8a\libretro.so' }
  fceumm   = @{ repo = 'https://github.com/libretro/libretro-fceumm.git';  kind = 'ndk'; jni = 'jni';                        lib = 'libs\arm64-v8a\libretro.so' }
  ppsspp   = @{ repo = 'https://github.com/hrydgard/ppsspp.git';           kind = 'cmake'; target = 'ppsspp_libretro'; lib = 'build-android\lib\ppsspp_libretro.so' }
  # 2026-10-28: the rest of the library's consoles, so the phone needs no other emulator app.
  genesis_plus_gx = @{ repo = 'https://github.com/libretro/Genesis-Plus-GX.git'; kind = 'ndk'; jni = 'libretro\jni'; lib = 'libretro\libs\arm64-v8a\libretro.so' }
  picodrive       = @{ repo = 'https://github.com/libretro/picodrive.git';       kind = 'ndk'; jni = 'jni';          lib = 'libs\arm64-v8a\libretro.so' }
  pcsx_rearmed    = @{ repo = 'https://github.com/libretro/pcsx_rearmed.git';    kind = 'ndk'; jni = 'jni';          lib = 'libs\arm64-v8a\libretro.so' }
  parallel_n64    = @{ repo = 'https://github.com/libretro/parallel-n64.git';    kind = 'ndk'; jni = 'jni';          lib = 'libs\arm64-v8a\libretro.so' }
  fbneo           = @{ repo = 'https://github.com/libretro/FBNeo.git';           kind = 'ndk'; jni = 'src\burner\libretro\jni'; lib = 'src\burner\libretro\libs\arm64-v8a\libretro.so' }
  mame2003_plus   = @{ repo = 'https://github.com/libretro/mame2003-plus-libretro.git'; kind = 'ndk'; jni = 'jni'; lib = 'libs\arm64-v8a\libretro.so' }
  stella2014      = @{ repo = 'https://github.com/libretro/stella2014-libretro.git'; kind = 'ndk'; jni = 'jni';      lib = 'libs\arm64-v8a\libretro.so' }
  melonds         = @{ repo = 'https://github.com/libretro/melonDS.git';         kind = 'ndk'; jni = 'jni';          lib = 'libs\arm64-v8a\libretro.so' }
  # OpenGL ES only: the phone engine gives cores a GLES 3 context (hw_egl.rs), not Vulkan.
  flycast         = @{ repo = 'https://github.com/flyinghead/flycast.git'; kind = 'cmake'; target = 'flycast_libretro'; lib = 'build-android\flycast_libretro_android.so'
                       flags = @('-DLIBRETRO=ON', '-DUSE_GLES=ON', '-DUSE_VULKAN=OFF', '-DUSE_OPENMP=OFF', '-DUSE_HOST_LIBZIP=OFF', '-DUSE_LUA=OFF', '-DUSE_BREAKPAD=OFF', '-DUSE_ALSA=OFF', '-DUSE_PULSEAUDIO=OFF', '-DUSE_LIBAO=OFF') }
  # GameCube and Wii, as Dolphin's own CI builds its Android core (-DLIBRETRO=ON).
  dolphin         = @{ repo = 'https://github.com/libretro/dolphin.git'; kind = 'cmake'; target = 'dolphin_libretro'; lib = 'build-android\Binaries\dolphin_libretro.so'
                       flags = @('-DLIBRETRO=ON', '-DENABLE_LTO=OFF') }
}
$c = $cores[$Core]
if (-not $c) { throw "Unknown core '$Core'. Known: $($cores.Keys -join ', ')" }
$dir = Join-Path $Src ($c.repo -replace '.*/', '' -replace '\.git$', '')
if (-not (Test-Path $dir)) {
  git clone --depth 1 --recurse-submodules --shallow-submodules $c.repo $dir
}
Push-Location $dir
try {
  $commit = (git rev-parse --short HEAD)
  if ($c.kind -eq 'ndk') {
    Push-Location $c.jni
    # Short commands: a core with hundreds of files overflows Windows' command-line limit when linking.
    & "$Ndk\ndk-build.cmd" APP_ABI=arm64-v8a APP_PLATFORM=android-26 APP_SHORT_COMMANDS=true -j8
    if ($LASTEXITCODE) { throw "ndk-build failed ($LASTEXITCODE)" }
    Pop-Location
  } else {
    & "$CMakeBin\cmake.exe" -S . -B build-android -G Ninja "-DCMAKE_MAKE_PROGRAM=$CMakeBin\ninja.exe" `
      "-DCMAKE_TOOLCHAIN_FILE=$Ndk\build\cmake\android.toolchain.cmake" -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-26 `
      -DCMAKE_BUILD_TYPE=Release @($c.flags)
    if ($LASTEXITCODE) { throw "cmake configure failed ($LASTEXITCODE)" }
    & "$CMakeBin\cmake.exe" --build build-android --target $c.target -j 8
    if ($LASTEXITCODE) { throw "build failed ($LASTEXITCODE)" }
  }
  $built = Join-Path $dir $c.lib
  if (-not (Test-Path $built)) { $built = (Get-ChildItem $dir -Recurse -Filter '*libretro*.so' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
  $dest = Join-Path $Out "$($Core)_libretro_android.so"
  Copy-Item $built $dest -Force
  # Strip debug symbols: what ships to phones is the code only.
  & "$Ndk\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-strip.exe" --strip-unneeded $dest
  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
  $size = (Get-Item $dest).Length
  # A manifest the host serves next to the cores: what each one is built from.
  $manifestPath = Join-Path $Out 'cores.json'
  $manifest = if (Test-Path $manifestPath) { Get-Content $manifestPath -Raw | ConvertFrom-Json } else { $null }
  if (-not $manifest) { $manifest = New-Object PSObject }
  $entry = [pscustomobject]@{ file = "$($Core)_libretro_android.so"; abi = 'arm64-v8a'; source = $c.repo; commit = $commit; sha256 = $hash; size = $size; builtAt = (Get-Date).ToUniversalTime().ToString('o') }
  $manifest | Add-Member -NotePropertyName $Core -NotePropertyValue $entry -Force
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding ascii $manifestPath   # no BOM: plain JSON for the server
  "Built $Core ($commit): $dest ($([math]::Round($size / 1MB, 1)) MB)"
} finally { Pop-Location }
