# Builds SaveState's own Windows (x86_64) copies of the libretro cores whose
# Windows builds use Microsoft's compiler (PPSSPP, PCSX2 (LRPS2)), from their
# official sources, as libretro's own CI does. The MinGW cores (Dolphin and
# Citra among them) are built by build-core-windows.sh; finished cores land in the same place
# (releases/cores/windows/x86_64/<core>_libretro.dll.zip + cores.json), or in
# the staging folder with -Staging until they have played a real game.
#
# Needs Visual Studio 2022 Build Tools (C++ workload, Windows SDK, CMake and
# Ninja come with it). No admin rights.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File engine\cores\build-core-msvc.ps1 -Staging ppsspp pcsx2
param(
  [switch]$Staging,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Cores
)
# Not 'Stop': Windows PowerShell turns a native tool's stderr (CMake's
# warnings) into a fatal error then. Exit codes and the built file decide.
$ErrorActionPreference = 'Continue'
$Repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Src = 'G:\Projects\savestate-cores-win'
$Out = if ($Staging) { Join-Path $Repo 'releases\cores-staging\windows\x86_64' } else { Join-Path $Repo 'releases\cores\windows\x86_64' }
$Logs = Join-Path $Src 'logs'
New-Item -ItemType Directory -Force $Src, $Out, $Logs | Out-Null
$Jobs = [Math]::Max(1, [Environment]::ProcessorCount - 2)   # leave the PC room for the server and games

# core = repository, extra CMake arguments, CMake target, built file name
$Recipes = @{
  # The UWP text drawer's header is off for libretro builds, its .cpp wasn't
  # (upstream builds the core with its Makefile, never CMake on Windows).
  # Pinned to the commit libretro's nightly of 2026-11-10 is built from (plays Daxter live; v1.20.4 built this way stopped at its splash). Later main-branch commits (the Nov 2026 core-context change,
  # SetGLCoreContext) pick GLSL 1.40 on Windows and their shaders don't link.
  ppsspp  = @{ repo = 'https://github.com/hrydgard/ppsspp.git'; ref = '55d87956fcdd5a93b7e0d9129c357cbcf2089f96'; target = 'ppsspp_libretro'; dll = 'ppsspp_libretro.dll'
               args = @('-DLIBRETRO=ON', '-DCMAKE_C_FLAGS_INIT=/DNOMINMAX', '-DCMAKE_CXX_FLAGS_INIT=/DNOMINMAX')
               fixes = @(@{ file = 'Common\Render\Text\draw_text_uwp.cpp'; find = '(?m)^#if defined\(_WIN32\)\r?$'; replace = '#if defined(_WIN32) && !defined(__LIBRETRO__)' }) }
  pcsx2   = @{ repo = 'https://github.com/libretro/ps2.git'; target = 'pcsx2_libretro'; dll = 'pcsx2_libretro.dll'
               args = @('-DCMAKE_POLICY_VERSION_MINIMUM=3.18') }
}

# Microsoft's compiler environment (vcvars64), loaded into this process.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { $vs = Get-ChildItem "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\*\VC\Auxiliary\Build\vcvars64.bat" -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { $_.Directory.Parent.Parent.Parent.FullName } }
if (-not $vs) { throw 'Visual Studio Build Tools with the C++ workload are not installed.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] } }
$cmakeDir = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake'
$env:PATH = "$cmakeDir\CMake\bin;$cmakeDir\Ninja;$env:PATH"

# Only the system DLLs every Windows has, so the core runs on any PC.
$SystemDlls = '^(kernel32|user32|gdi32|winmm|ole32|oleaut32|shell32|advapi32|ws2_32|opengl32|dsound|dinput8|xinput1_4|xinput9_1_0|comdlg32|shlwapi|version|bcrypt|setupapi|hid|imm32|dxgi|d3d11|d3d12|d3dcompiler_47|uxtheme|dwmapi|iphlpapi|psapi|crypt32|secur32|ntdll|vulkan-1|mfplat|mfreadwrite|mf|propsys|avrt|cfgmgr32|dbghelp|userenv|wtsapi32|rpcrt4|comctl32|powrprof|netapi32|mpr|winhttp|mswsock|ncrypt|normaliz|wldap32|dnsapi|api-ms-win-.*)\.dll$'

function Build-Core([string]$core) {
  $r = $Recipes[$core]
  if (-not $r) { Write-Host "${core}: no recipe"; return $false }
  # A recipe may pin a release tag or an exact commit (ref): its own folder,
  # so the main branch's stays.
  $isSha = $r.ref -and ($r.ref -match '^[0-9a-f]{40}$')
  $tree = if ($r.ref) { Join-Path $Src "$core-$(if ($isSha) { $r.ref.Substring(0, 8) } else { $r.ref })" } else { Join-Path $Src $core }
  $log = Join-Path $Logs "$core-msvc.log"
  if (-not (Test-Path (Join-Path $tree '.git'))) {
    Write-Host "${core}: cloning $($r.repo)$(if ($r.ref) { " at $($r.ref)" })"
    if ($isSha) {
      # A commit can't be cloned by name: fetch just that commit.
      git init $tree 2>&1 | Out-File -FilePath $log -Encoding utf8
      git -C $tree remote add origin $r.repo
      git -C $tree fetch --depth 1 origin $r.ref 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
      git -C $tree checkout FETCH_HEAD 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
      git -C $tree submodule update --init --recursive --depth 1 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
    } else {
      $branch = if ($r.ref) { @('--branch', $r.ref) } else { @() }
      git clone --depth 1 --recursive --shallow-submodules @branch $r.repo $tree 2>&1 | Out-File -FilePath $log -Encoding utf8
    }
    if ($LASTEXITCODE -ne 0) { Write-Host "${core}: clone failed (see $log)"; return $false }
  }
  # Small source fixes for building the core this way (each matches once, so re-runs are no-ops).
  foreach ($f in @($r.fixes)) {
    if (-not $f) { continue }
    $p = Join-Path $tree $f.file
    if (-not (Test-Path $p)) { continue }
    $text = [IO.File]::ReadAllText($p)
    $re = [regex]$f.find
    if ($re.IsMatch($text)) { [IO.File]::WriteAllText($p, $re.Replace($text, $f.replace, 1)); Write-Host "${core}: fixed $($f.file)" }
  }
  $commit = (git -C $tree rev-parse --short HEAD).Trim()
  Write-Host "${core}: building $commit"
  $t0 = Get-Date
  $build = Join-Path $tree 'build-msvc'
  Remove-Item -Force (Join-Path $build 'CMakeCache.txt') -ErrorAction SilentlyContinue
  # The C runtime is linked in (/MT): VCRUNTIME140.dll isn't on every PC.
  $cfg = @('-G', 'Ninja', '-S', $tree, '-B', $build, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
           '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DCMAKE_C_COMPILER=cl', '-DCMAKE_CXX_COMPILER=cl') + $r.args
  # From inside the core's own tree: version scripts ask git in the current
  # folder (PCSX2 reported SaveState's commit as its own otherwise).
  Push-Location $tree
  & cmake @cfg 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
  if ($LASTEXITCODE -eq 0) { & cmake --build $build --target $r.target -j $Jobs 2>&1 | Out-File -FilePath $log -Append -Encoding utf8 }
  Pop-Location
  $dll = Get-ChildItem $build -Recurse -Filter $r.dll -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $mins = [Math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
  if (-not $dll -or $dll.LastWriteTime -lt $t0) {
    Write-Host "${core}: FAILED after $mins min (tail of $log):"
    Get-Content $log -Tail 20 | Select-String -Pattern 'error|Error|FAILED|fatal' | Select-Object -Last 12 | ForEach-Object { "  $_" }
    return $false
  }
  $deps = & dumpbin /nologo /dependents $dll.FullName | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '\.dll$' -and $_ -notmatch '^Dump of' } | ForEach-Object { $_.ToLower() } | Where-Object { $_ -notmatch $SystemDlls }
  if ($deps) { Write-Host "${core}: needs DLLs other PCs won't have: $($deps -join ', ')"; return $false }
  $name = "${core}_libretro.dll"
  $zip = Join-Path $Out "$name.zip"
  $tmp = Join-Path $env:TEMP "savestate-msvc-$core"
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; New-Item -ItemType Directory $tmp | Out-Null
  Copy-Item $dll.FullName (Join-Path $tmp $name)
  Remove-Item -Force $zip -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $tmp $name) -DestinationPath $zip -CompressionLevel Optimal
  Remove-Item -Recurse -Force $tmp
  $sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  $size = (Get-Item $zip).Length
  # (Windows PowerShell mangles quotes in a script passed to node -e: a file.)
  $js = Join-Path $env:TEMP 'savestate-cores-json.cjs'
  Set-Content -Path $js -Encoding ascii -Value @'
const fs = require("fs"), [f, core, file, sha, size, source, commit] = process.argv.slice(2);
const j = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
j[core] = { file, sha256: sha, size: +size, source, commit, builtAt: new Date().toISOString(), compiler: "msvc" };
fs.writeFileSync(f, JSON.stringify(j, null, 2));
'@
  node $js (Join-Path $Out 'cores.json') $core "$name.zip" $sha $size $r.repo $commit
  Write-Host "${core}: OK in $mins min ($([int]($size / 1KB)) KB zipped)"
  return $true
}

$status = 0
foreach ($c in $Cores) { if (-not (Build-Core $c)) { $status = 1 } }
exit $status
