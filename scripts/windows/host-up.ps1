# Make this Windows PC the host for savestate.co.za, natively (no WSL).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\host-up.ps1
#   ... -Bundle E:\savestate-host-bundle-20260929-170119.tar.gz.gpg
#
# What it does, in order, stopping with the fix if anything fails:
#   1. installs what is missing with winget: Node 22+, ffmpeg, cloudflared,
#      and (for the Google Drive library) rclone + WinFsp
#   2. restores the tunnel credential and app secrets from the host bundle
#      (found automatically on the USB stick), unless they are already here
#   3. installs npm packages and builds the server (never the frontend:
#      dist/ is the committed build and there are no Vite sources)
#   4. registers a "SaveState Host" task that starts the app, the tunnel and
#      the Drive mount at logon and restarts them if they stop
#   5. waits for the app, the tunnel and https://savestate.co.za to answer
#
# Only ONE machine may run the tunnel. Stop the old host first.
# Written for Windows PowerShell 5.1 (the one built into Windows).

param(
  [string]$Bundle = '',
  [switch]$SkipDrive
)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$AppDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$Domain = 'savestate.co.za'
$CfDir = Join-Path $HOME '.cloudflared'
$script:Failed = $false

function Ok($m)   { Write-Host "  ok   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  --   $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "  !!   $m" -ForegroundColor Red; $script:Failed = $true }
function Fix($m)  { Write-Host "       fix: $m" -ForegroundColor Cyan }
function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Stop-Here { Write-Host ""; Bad 'stopped - fix the item above and run this script again'; exit 1 }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Find-Exe([string]$name, [string[]]$extra) {
  $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  foreach ($p in $extra) { if ($p -and (Test-Path $p)) { return $p } }
  $links = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$name.exe"
  if (Test-Path $links) { return $links }
  $pkg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path $pkg) {
    $hit = Get-ChildItem -Path $pkg -Recurse -Filter "$name.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Winget-Install([string]$id) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Bad "winget is not available, so $id cannot be installed automatically"
    Fix 'install "App Installer" from the Microsoft Store, then run this again'
    Stop-Here
  }
  Write-Host "       installing $id ..."
  & winget install -e --id $id --silent --accept-source-agreements --accept-package-agreements | Out-Host
  Refresh-Path
}

function Ensure([string]$name, [string]$id, [string[]]$extra, [bool]$required) {
  $exe = Find-Exe $name $extra
  if (-not $exe) { Winget-Install $id; $exe = Find-Exe $name $extra }
  if ($exe) { Ok "$name ($exe)"; return $exe }
  if ($required) { Bad "$name could not be installed"; Fix "winget install -e --id $id"; Stop-Here }
  Warn "$name not installed"
  return $null
}

function To-Slash([string]$p) { return ($p -replace '\\', '/') }

# Linux paths from the old host (/home/<user>/...) -> this PC's home folder.
function Convert-LinuxPaths([string]$file) {
  if (-not (Test-Path $file)) { return }
  $text = [IO.File]::ReadAllText($file)
  $home2 = To-Slash $HOME
  $new = [regex]::Replace($text, '/home/[^/\s"'':]+', $home2)
  if ($new -ne $text) {
    Copy-Item $file "$file.linux-backup" -Force
    [IO.File]::WriteAllText($file, $new)
    Ok "rewrote Linux paths in $(Split-Path -Leaf $file)"
  }
}

function Place([string]$src, [string]$dst) {
  if (-not (Test-Path $src)) { return $false }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  if (Test-Path $dst) { Copy-Item $dst ("$dst.pre-import-" + (Get-Date -Format 'yyyyMMddHHmmss')) -Force }
  Copy-Item $src $dst -Force
  Ok "restored $(Split-Path -Leaf $dst)"
  return $true
}

function Tunnel-Credential {
  if (-not (Test-Path $CfDir)) { return $null }
  # A PC can hold credentials for several tunnels (other sites). Prefer the one
  # the existing tunnel config already names, so this never picks another
  # site's tunnel just because its file sorts first.
  foreach ($cfg in @((Join-Path $DataDir 'cloudflared\config.yml'), (Join-Path $CfDir 'config.yml'))) {
    if (-not (Test-Path $cfg)) { continue }
    $m = Select-String -Path $cfg -Pattern '^\s*tunnel\s*:\s*([0-9a-fA-F-]{36})' | Select-Object -First 1
    if (-not $m) { continue }
    $id = $m.Matches[0].Groups[1].Value
    $f = Join-Path $CfDir "$id.json"
    if (Test-Path $f) { return @{ file = $f; id = $id } }
  }
  foreach ($f in Get-ChildItem -Path $CfDir -Filter '*.json' -File -ErrorAction SilentlyContinue) {
    try {
      $j = Get-Content $f.FullName -Raw | ConvertFrom-Json
      if ($j.TunnelID) { return @{ file = $f.FullName; id = [string]$j.TunnelID } }
    } catch { }
  }
  return $null
}

function Find-Bundle([string]$hint) {
  if ($hint) {
    if (Test-Path $hint) { return (Resolve-Path $hint).Path }
    Bad "bundle not found at $hint"; Stop-Here
  }
  $roots = @($HOME, (Join-Path $HOME 'Downloads'), (Join-Path $HOME 'Desktop'))
  $roots += (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { $_.Root })
  foreach ($r in $roots) {
    if (-not $r -or -not (Test-Path $r)) { continue }
    $f = Get-ChildItem -Path $r -Filter 'savestate-host-bundle-*.tar.gz*' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f) { return $f.FullName }
  }
  return $null
}

# -----------------------------------------------------------------------------
Write-Host "SaveState host setup for $AppDir" -ForegroundColor Cyan

Step 'Tools'
$node = Find-Exe 'node' @("$env:ProgramFiles\nodejs\node.exe")
$nodeOk = $false
if ($node) {
  $v = (& $node --version) -replace '^v', ''
  if ([int]($v.Split('.')[0]) -ge 22) { $nodeOk = $true } else { Warn "node $v is too old (22+ needed)" }
}
if (-not $nodeOk) {
  Winget-Install 'OpenJS.NodeJS.LTS'
  $node = Find-Exe 'node' @("$env:ProgramFiles\nodejs\node.exe")
  if (-not $node) { Bad 'Node.js could not be installed'; Fix 'install Node 22 LTS from https://nodejs.org and run this again'; Stop-Here }
}
Ok "node $(& $node --version) ($node)"
$npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }

$cloudflared = Ensure 'cloudflared' 'Cloudflare.cloudflared' @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") $true
$ffmpeg = Ensure 'ffmpeg' 'Gyan.FFmpeg' @() $false
if (-not $ffmpeg) { Warn 'video that needs converting will not play until ffmpeg is installed' }

# -- Data folder -------------------------------------------------------------
# The server keeps its state in NEXUS_DATA_DIR. A previous native install on
# this PC used %APPDATA%\NexusEmuHost; keep using it if that is where the
# data is and no bundle is being imported.
$DataDir = Join-Path $HOME '.nexus-data'
$legacy = Join-Path $env:APPDATA 'NexusEmuHost'

Step 'Tunnel credential and secrets'
$envFile = Join-Path $AppDir '.env'
$cred = Tunnel-Credential
$needImport = ($Bundle -ne '') -or (-not $cred) -or (-not (Test-Path $envFile))
if (-not $needImport) {
  Ok "tunnel credential present ($($cred.id))"
  Ok '.env present'
  if (-not (Test-Path (Join-Path $DataDir 'host-state.json')) -and (Test-Path (Join-Path $legacy 'host-state.json'))) {
    $DataDir = $legacy
    Ok "using existing data in $DataDir"
  }
} else {
  $bundleFile = Find-Bundle $Bundle
  if (-not $bundleFile) {
    Bad 'no tunnel credential on this PC and no host bundle found'
    Fix 'plug in the USB stick with savestate-host-bundle-*.tar.gz.gpg (or copy it to your Downloads folder) and run this again'
    Fix 'or pass it directly: -Bundle E:\savestate-host-bundle-XXXX.tar.gz.gpg'
    Stop-Here
  }
  Ok "bundle: $bundleFile"
  $stage = Join-Path $env:TEMP ('savestate-import-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  $tgz = $bundleFile
  if ($bundleFile -like '*.gpg') {
    $gpg = Ensure 'gpg' 'GnuPG.GnuPG' @("${env:ProgramFiles(x86)}\GnuPG\bin\gpg.exe", "$env:ProgramFiles\GnuPG\bin\gpg.exe", "${env:ProgramFiles(x86)}\Gpg4win\..\GnuPG\bin\gpg.exe") $true
    $tgz = Join-Path $stage 'bundle.tar.gz'
    Write-Host '       enter the bundle passphrase when asked'
    & $gpg --pinentry-mode loopback --output $tgz --decrypt $bundleFile
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tgz)) { Bad 'decryption failed (wrong passphrase?)'; Stop-Here }
  }
  & tar.exe -xzf $tgz -C $stage
  $B = Join-Path $stage 'bundle'
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $B)) { Bad 'could not unpack the bundle'; Stop-Here }
  $manifest = Join-Path $B 'MANIFEST.txt'
  if (Test-Path $manifest) { Get-Content $manifest | ForEach-Object { Write-Host "       $_" } }

  New-Item -ItemType Directory -Force -Path $CfDir, $DataDir, (Join-Path $DataDir 'cloudflared') | Out-Null
  foreach ($f in Get-ChildItem -Path (Join-Path $B 'cloudflared') -Filter '*.json' -File -ErrorAction SilentlyContinue) {
    [void](Place $f.FullName (Join-Path $CfDir $f.Name))
  }
  [void](Place (Join-Path $B 'cloudflared\config.yml') (Join-Path $DataDir 'cloudflared\config.yml'))
  $rcloneDir = Join-Path $HOME '.config\rclone'
  foreach ($f in Get-ChildItem -Path (Join-Path $B 'rclone') -File -ErrorAction SilentlyContinue) {
    [void](Place $f.FullName (Join-Path $rcloneDir $f.Name))
  }
  [void](Place (Join-Path $B 'env\.env') $envFile)
  [void](Place (Join-Path $B 'env\.env.production') (Join-Path $AppDir '.env.production'))
  foreach ($f in Get-ChildItem -Path (Join-Path $B 'state') -Filter '*.json' -File -ErrorAction SilentlyContinue) {
    [void](Place $f.FullName (Join-Path $DataDir $f.Name))
  }
  $content = Join-Path $B 'content'
  if (Test-Path $content) {
    foreach ($d in Get-ChildItem -Path $content -Directory) {
      # Merge, never overwrite: /XC /XN /XO skip files that already exist.
      & robocopy.exe $d.FullName (Join-Path $DataDir $d.Name) /E /XC /XN /XO /NFL /NDL /NJH /NJS /NP | Out-Null
      Ok "content: $($d.Name)"
    }
  }
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  $cred = Tunnel-Credential
  if (-not $cred) { Bad 'the bundle did not contain a tunnel credential (*.json)'; Stop-Here }
}

Convert-LinuxPaths $envFile
Convert-LinuxPaths (Join-Path $AppDir '.env.production')
Convert-LinuxPaths (Join-Path $HOME '.config\rclone\rclone.conf')

# -- Tunnel config -----------------------------------------------------------
# Run by tunnel ID with an explicit credentials file, so no Cloudflare login
# (cert.pem) is needed on this PC.
$tunnelConfig = Join-Path $DataDir 'cloudflared\config.yml'
if (-not (Test-Path $tunnelConfig) -and (Test-Path (Join-Path $CfDir 'config.yml'))) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $tunnelConfig) | Out-Null
  Copy-Item (Join-Path $CfDir 'config.yml') $tunnelConfig
}
if (Test-Path $tunnelConfig) {
  Convert-LinuxPaths $tunnelConfig
  $lines = [IO.File]::ReadAllLines($tunnelConfig)
} else {
  $lines = @()
}
$credSlash = To-Slash $cred.file
$out = New-Object System.Collections.Generic.List[string]
$hasIngress = $false
foreach ($l in $lines) {
  if ($l -match '^\s*tunnel\s*:') { continue }
  if ($l -match '^\s*credentials-file\s*:') { continue }
  if ($l -match '^\s*origincert\s*:') { continue }
  if ($l -match '^\s*logfile\s*:') { continue }
  if ($l -match '^\s*ingress\s*:') { $hasIngress = $true }
  $out.Add($l)
}
$out.Insert(0, "credentials-file: $credSlash")
$out.Insert(0, "tunnel: $($cred.id)")
if (-not $hasIngress) {
  $out.Add('ingress:')
  $out.Add('  - service: http://localhost:3000')
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $tunnelConfig) | Out-Null
[IO.File]::WriteAllLines($tunnelConfig, $out)
Ok "tunnel config: $tunnelConfig (tunnel $($cred.id))"
$svc = ($out | Where-Object { $_ -match 'service\s*:\s*http' } | Select-Object -First 1)
if ($svc) { Ok "tunnel forwards to: $($svc.Trim())" }

# -- Google Drive mount (the media and ROM library) --------------------------
$rcloneConf = Join-Path $HOME '.config\rclone\rclone.conf'
# rclone's own default on Windows, where `rclone config` puts it.
$appDataConf = Join-Path $env:APPDATA 'rclone\rclone.conf'
if (-not (Test-Path $rcloneConf) -and (Test-Path $appDataConf)) { $rcloneConf = $appDataConf }
$rclone = $null; $remote = $null; $mountPoint = $null
# Google Drive for Desktop, when signed in, is preferred over an rclone mount:
# it has its own API quota, while rclone's shared client id is rate-limited so
# hard that reads fall to a few hundred KB/s (measured 0.2-0.7 MB/s against
# ~6 MB/s through Drive for Desktop on this line) and video stalls.
$driveFs = $null
foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
  $p = Join-Path $d.Root 'My Drive\NexusArchive'
  if (Test-Path -LiteralPath $p) { $driveFs = $p; break }
}
$libraryLink = Join-Path $HOME 'nexus-cloud-media'
if ($SkipDrive) {
  Warn 'Drive mount skipped (-SkipDrive)'
} elseif ($driveFs) {
  # The library, the database and the game vault all use ~\nexus-cloud-media,
  # so it becomes a link to the Drive for Desktop folder instead of a mount.
  # An rclone mount still sitting on that path is unmounted first.
  $mounts = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'rclone.exe' -and $_.CommandLine -like '*NexusArchive*' }
  if ($mounts) {
    & schtasks.exe /End /TN 'SaveState Host' 2>$null | Out-Null
    $mounts | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
  }
  if (Test-Path -LiteralPath $libraryLink) {
    $item = Get-Item -LiteralPath $libraryLink -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { & cmd.exe /c rmdir "$libraryLink" | Out-Null }
    elseif (-not (Get-ChildItem -LiteralPath $libraryLink -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $libraryLink -Force }
  }
  if (Test-Path -LiteralPath $libraryLink) {
    Warn "$libraryLink has files in it, so it cannot link to Google Drive; move them and run again"
  } else {
    & cmd.exe /c mklink /J "$libraryLink" "$driveFs" | Out-Null
    if (Test-Path -LiteralPath (Join-Path $libraryLink 'movies')) { Ok "Google Drive for Desktop: $libraryLink -> $driveFs" }
    else { Warn "could not link $libraryLink to $driveFs" }
  }
} elseif (-not (Test-Path $rcloneConf)) {
  Warn 'no rclone.conf - the media/ROM library will be empty until Google Drive is set up'
} else {
  $m = Select-String -Path $rcloneConf -Pattern '^\[(.+)\]' | Select-Object -First 1
  if ($m) { $remote = $m.Matches[0].Groups[1].Value }
  foreach ($r in (Select-String -Path $rcloneConf -Pattern '^\[(.+)\]')) {
    if ($r.Matches[0].Groups[1].Value -eq 'gdrive') { $remote = 'gdrive' }
  }
  $rclone = Ensure 'rclone' 'Rclone.Rclone' @() $false
  $winfsp = (Test-Path "${env:ProgramFiles(x86)}\WinFsp\bin\winfsp-x64.dll") -or (Test-Path "$env:ProgramFiles\WinFsp\bin\winfsp-x64.dll")
  if (-not $winfsp) {
    Write-Host '       WinFsp (needed to mount Google Drive) asks for administrator approval'
    Winget-Install 'WinFsp.WinFsp'
    $winfsp = (Test-Path "${env:ProgramFiles(x86)}\WinFsp\bin\winfsp-x64.dll") -or (Test-Path "$env:ProgramFiles\WinFsp\bin\winfsp-x64.dll")
  }
  if ($rclone -and $winfsp -and $remote) {
    $mountPoint = Join-Path $HOME 'nexus-cloud-media'
    # rclone creates the mount folder itself and refuses one that exists.
    if (Test-Path $mountPoint) {
      $item = Get-Item $mountPoint -Force
      $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
      if (-not $isLink -and -not (Get-ChildItem $mountPoint -Force -ErrorAction SilentlyContinue)) { Remove-Item $mountPoint -Force }
      elseif (-not $isLink) { Warn "$mountPoint has files in it, so Drive cannot be mounted there; move them and run again"; $mountPoint = $null }
    }
    if ($mountPoint) { Ok "Drive ($remote`:NexusArchive) will mount at $mountPoint" }
  } else {
    Warn 'Google Drive will not be mounted (rclone/WinFsp missing) - the site still runs, with an empty library'
  }
}

# -- App ---------------------------------------------------------------------
Step 'App'
Set-Location $AppDir
# Stop what is running first: npm cannot replace files a running node holds.
& schtasks.exe /End /TN 'SaveState Host' 2>$null | Out-Null
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*tunnel*') -or
  ($_.Name -eq 'node.exe' -and ($_.CommandLine -like '*server.mjs*' -or $_.CommandLine -like '*server.ts*')) -or
  ($_.Name -eq 'rclone.exe' -and $_.CommandLine -like '*NexusArchive*') -or
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*run-host.ps1*')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$lock = Join-Path $AppDir 'package-lock.json'
$marker = Join-Path $AppDir 'node_modules\.package-lock.json'
if (-not (Test-Path $marker) -or ((Get-Item $lock).LastWriteTime -gt (Get-Item $marker).LastWriteTime)) {
  Write-Host '       installing npm packages (a few minutes the first time) ...'
  & $npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Bad 'npm ci failed'; Fix "cd `"$AppDir`"; npm ci"; Stop-Here }
}
Ok 'npm packages installed'

# Server only. Never `vite build` / `npm run build`: the frontend sources were
# lost and dist\ is the committed, working build.
$serverArgs = @('dist/server.mjs')
$esbuild = Join-Path $AppDir 'node_modules\.bin\esbuild.cmd'
& $esbuild server.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=dist/server.mjs --log-level=warning
if ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $AppDir 'dist\server.mjs'))) {
  Ok 'server built (dist\server.mjs)'
} else {
  Warn 'server build failed - running from source with tsx instead (slower start)'
  $serverArgs = @('--import', 'tsx', 'server.ts')
}

# -- Keep it running ---------------------------------------------------------
Step 'Autostart'
$ffmpegDir = $null
if ($ffmpeg) { $ffmpegDir = Split-Path -Parent $ffmpeg }
$hostCfg = [ordered]@{
  appDir = $AppDir; dataDir = $DataDir; node = $node; serverArgs = $serverArgs
  cloudflared = $cloudflared; tunnelConfig = $tunnelConfig; ffmpegDir = $ffmpegDir
  rclone = $rclone; rcloneConfig = $(if ($mountPoint) { $rcloneConf } else { $null })
  rcloneRemote = $remote; mountPoint = $mountPoint
  waitForPath = $(if ($driveFs) { Join-Path $libraryLink 'movies' } else { $null })
}
$hostCfg | ConvertTo-Json | Set-Content -Path (Join-Path $HOME '.nexus-windows-host.json') -Encoding ASCII
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir 'logs') | Out-Null

$runner = Join-Path $AppDir 'scripts\windows\run-host.ps1'
$psArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs
  # Logon, plus every 5 minutes: if the watchdog is ever killed (it was, once,
  # taking the site down overnight) it comes back on its own. A second copy
  # exits at once because the running one holds the watchdog mutex.
  $trigger = @(
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
  )
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  Register-ScheduledTask -TaskName 'SaveState Host' -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName 'SaveState Host' -ErrorAction Stop
  $registered = $true
  Ok 'scheduled task "SaveState Host" registered and started (runs at every logon)'
} catch {
  Warn "could not register the scheduled task ($($_.Exception.Message)); using the Startup folder instead"
}
if (-not $registered) {
  $startup = [Environment]::GetFolderPath('Startup')
  Set-Content -Path (Join-Path $startup 'SaveState Host.cmd') -Encoding ASCII -Value "@start `"`" /min powershell.exe $psArgs"
  Start-Process powershell.exe -ArgumentList $psArgs -WindowStyle Hidden
  Ok 'added to the Startup folder and started'
}

# A sleeping PC is a site that is down.
& powercfg.exe /change standby-timeout-ac 0 2>$null | Out-Null
& powercfg.exe /change hibernate-timeout-ac 0 2>$null | Out-Null
Ok 'sleep disabled while plugged in'

# -- Verify ------------------------------------------------------------------
Step 'Waiting for the app on http://127.0.0.1:3000'
$up = $false
for ($i = 0; $i -lt 60; $i++) {
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 3; if ($r.StatusCode -eq 200) { $up = $true; break } } catch { }
  Start-Sleep -Seconds 2
}
$logs = Join-Path $DataDir 'logs'
if ($up) { Ok 'app answering locally' } else {
  Bad 'the app did not start within 2 minutes - last log lines:'
  foreach ($f in @('server.err.log', 'server.log', 'watchdog.log')) {
    $p = Join-Path $logs $f
    if (Test-Path $p) { Write-Host "       -- $f"; Get-Content $p -Tail 15 | ForEach-Object { Write-Host "       $_" } }
  }
  Stop-Here
}

Step 'Waiting for the tunnel to connect to Cloudflare'
$reg = $false
$tlog = Join-Path $logs 'tunnel.err.log'
for ($i = 0; $i -lt 45; $i++) {
  if ((Test-Path $tlog) -and (Select-String -Path $tlog -Pattern 'Registered tunnel connection' -Quiet)) { $reg = $true; break }
  Start-Sleep -Seconds 2
}
if ($reg) { Ok 'tunnel connected' } else {
  Bad 'the tunnel did not connect - last log lines:'
  if (Test-Path $tlog) { Get-Content $tlog -Tail 20 | ForEach-Object { Write-Host "       $_" } }
  Fix 'a firewall/antivirus blocking cloudflared.exe on outbound port 443, or a credential for a deleted tunnel'
  Stop-Here
}

Step "Checking https://$Domain from the internet"
$code = $null; $origin = $null
for ($i = 0; $i -lt 10; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri "https://$Domain/api/health" -TimeoutSec 20
    $code = $r.StatusCode; $origin = $r.Headers['X-SaveState-Origin']
    if ($code -eq 200) { break }
  } catch { $code = $_.Exception.Message }
  Start-Sleep -Seconds 3
}
if ($code -eq 200) {
  Ok "https://$Domain/api/health -> 200 (answered by: $origin)"
} else {
  Bad "https://$Domain did not answer 200 ($code)"
  Fix 'if the old laptop still runs the tunnel, stop it: systemctl --user disable --now cloudflared-nexus nexus-host'
  Stop-Here
}

try {
  $h = Invoke-RestMethod -Uri "https://$Domain/api/health/full" -TimeoutSec 60
  Write-Host ""
  Write-Host "  overall: $($h.overall)  ($($h.passed)/$($h.total) passing, $($h.warned) warning)"
  foreach ($c in $h.checks) { if ($c.status -ne 'pass') { Write-Host ("    {0,-5} {1}: {2}" -f $c.status, $c.name, $c.message) } }
} catch { Warn 'full health report unavailable' }

Write-Host ""
Ok "savestate.co.za is served from this PC. Logs: $logs"
Write-Host '       It starts again by itself at every logon. Keep this PC signed in and plugged in.'
