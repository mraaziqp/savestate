# Keeps the SaveState host running on Windows: the Google Drive mount (when
# configured), the app server and the Cloudflare tunnel. Any of them that
# exits is started again. Written for Windows PowerShell 5.1.
#
# Started by the "SaveState Host" scheduled task that host-up.ps1 registers;
# it reads its paths from %USERPROFILE%\.nexus-windows-host.json.

$ErrorActionPreference = 'Continue'
$configFile = Join-Path $HOME '.nexus-windows-host.json'
if (-not (Test-Path $configFile)) { Write-Error "Missing $configFile - run scripts\windows\host-up.ps1 first"; exit 1 }
$cfg = Get-Content $configFile -Raw | ConvertFrom-Json

# One watchdog at a time.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\SaveStateHostWatchdog', [ref]$created)
if (-not $created) { exit 0 }

$logDir = Join-Path $cfg.dataDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$watchLog = Join-Path $logDir 'watchdog.log'
function Say($msg) { Add-Content -Path $watchLog -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) }

function Quote-Args([string[]]$list) {
  # Start-Process joins arguments with spaces and does not quote them.
  ($list | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
}

function Start-Part($name, $exe, [string[]]$argList, $workDir) {
  $out = Join-Path $logDir "$name.log"
  $err = Join-Path $logDir "$name.err.log"
  foreach ($f in @($out, $err)) {
    if ((Test-Path $f) -and ((Get-Item $f).Length -gt 20MB)) { Move-Item -Force $f "$f.old" }
  }
  $opts = @{
    FilePath = $exe; ArgumentList = (Quote-Args $argList); WorkingDirectory = $workDir
    RedirectStandardOutput = $out; RedirectStandardError = $err; PassThru = $true
  }
  if ($env:OS -eq 'Windows_NT') { $opts.WindowStyle = 'Hidden' }
  try {
    $p = Start-Process @opts
    Say "started $name (pid $($p.Id))"
    return $p
  } catch {
    Say "could not start ${name}: $($_.Exception.Message)"
    return $null
  }
}

$env:NODE_ENV = 'production'
$env:NEXUS_DATA_DIR = $cfg.dataDir
if ($cfg.ffmpegDir) { $env:Path = "$($cfg.ffmpegDir);$env:Path" }

$parts = @()
if ($cfg.rclone -and $cfg.rcloneConfig -and $cfg.mountPoint) {
  $parts += @{
    name = 'drive-mount'; exe = $cfg.rclone; dir = $cfg.dataDir; wait = 5
    args = @('mount', "$($cfg.rcloneRemote):NexusArchive", $cfg.mountPoint,
      "--config=$($cfg.rcloneConfig)", '--vfs-cache-mode=full',
      "--cache-dir=$(Join-Path $cfg.dataDir 'rclone-cache')",
      '--vfs-cache-max-size=12G', '--vfs-cache-max-age=24h',
      '--vfs-read-chunk-size=16M', '--vfs-read-chunk-size-limit=512M',
      '--vfs-read-ahead=256M', '--vfs-fast-fingerprint', '--buffer-size=64M',
      '--dir-cache-time=24h', '--transfers=8', '--checkers=16', '--read-only')
  }
}
$parts += @{ name = 'server'; exe = $cfg.node; dir = $cfg.appDir; wait = 8; args = $cfg.serverArgs }
$parts += @{
  name = 'tunnel'; exe = $cfg.cloudflared; dir = $cfg.dataDir; wait = 0
  args = @('tunnel', '--no-autoupdate', '--protocol', 'http2', '--config', $cfg.tunnelConfig, 'run')
}

$procs = @{}
$backoff = @{}
Say 'watchdog up'

# Google Drive for Desktop mounts its drive a little after logon. Starting the
# server before it appears would index an empty library until the next rescan.
if ($cfg.waitForPath) {
  for ($i = 0; $i -lt 90 -and -not (Test-Path -LiteralPath $cfg.waitForPath); $i++) { Start-Sleep -Seconds 2 }
  if (Test-Path -LiteralPath $cfg.waitForPath) { Say "library path ready: $($cfg.waitForPath)" }
  else { Say "library path not available after 3 min, starting anyway: $($cfg.waitForPath)" }
}
while ($true) {
  foreach ($part in $parts) {
    $p = $procs[$part.name]
    if ($p -and -not $p.HasExited) { continue }
    if ($p) {
      Say "$($part.name) exited with code $($p.ExitCode)"
      $delay = [Math]::Min(60, [int]($backoff[$part.name]) * 2 + 2)
      $backoff[$part.name] = $delay
      Start-Sleep -Seconds $delay
    }
    $procs[$part.name] = Start-Part $part.name $part.exe $part.args $part.dir
    if ($part.wait -gt 0) { Start-Sleep -Seconds $part.wait }
  }
  # A part that has stayed up for 10 minutes earns a fresh backoff.
  foreach ($k in @($backoff.Keys)) {
    $p = $procs[$k]
    if ($p -and -not $p.HasExited -and ((Get-Date) - $p.StartTime).TotalMinutes -gt 10) { $backoff[$k] = 0 }
  }
  Start-Sleep -Seconds 10
}
