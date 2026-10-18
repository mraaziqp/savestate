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
  # Each start writes a new log; the previous run's is kept as <name>.prev.log
  # (it was overwritten, so whatever went wrong before a restart was lost).
  foreach ($f in @($out, $err)) {
    if ((Test-Path $f) -and ((Get-Item $f).Length -gt 0)) { Move-Item -Force $f ($f -replace '\.log$', '.prev.log') }
  }
  $opts = @{
    FilePath = $exe; ArgumentList = (Quote-Args $argList); WorkingDirectory = $workDir
    RedirectStandardOutput = $out; RedirectStandardError = $err; PassThru = $true
  }
  if ($env:OS -eq 'Windows_NT') { $opts.WindowStyle = 'Hidden' }
  try {
    $p = Start-Process @opts
    # A scheduled task runs at below-normal priority and its children inherit
    # that; the tunnel and the server should not lose to every other program.
    try { $p.PriorityClass = 'Normal' } catch { }
    Say "started $name (pid $($p.Id))"
    return $p
  } catch {
    Say "could not start ${name}: $($_.Exception.Message)"
    return $null
  }
}

$env:NODE_ENV = 'production'
# Node does file reads, hashing and compression on 4 threads by default. The
# server ties them up (films and uploads, checksums, slow first reads from
# the Google Drive folder), and everything else waited: the page itself took
# up to 5 s to serve, a folder scan 110 s instead of 7 (2026-10-16). The size
# is read once at start-up, before any of the server's own code runs, so it
# can only be set here.
if (-not $env:UV_THREADPOOL_SIZE) { $env:UV_THREADPOOL_SIZE = '16' }
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
# Apps that only listen on 127.0.0.1 (Jarvis), reachable from the NAS, which
# runs the tunnel once this PC's is off (deploy/qnap). "lanForward": ["3006:3005"].
if ($cfg.lanForward) {
  $parts += @{ name = 'lan-forward'; exe = $cfg.node; dir = $cfg.appDir; wait = 0
    args = @('scripts/windows/lan-forward.cjs') + @($cfg.lanForward) }
}
# The NAS serves savestate.co.za when this file exists; this PC then keeps its
# server (uploads, the Arr apps) but not its tunnel: two connectors on one
# tunnel would split visitors between the two hosts. Delete it to go back.
$tunnelOff = Join-Path $cfg.dataDir 'tunnel.off'

$procs = @{}
$backoff = @{}
Say 'watchdog up'

# Google Drive for Desktop sometimes drops its drive letter while its process
# keeps running (2026-10-13: I: vanished mid-afternoon and the library showed
# 15 videos instead of 1,023 until Drive was restarted by hand). When the
# library path has been gone for 30 seconds, restart Drive; the server
# rescans by itself once the path is back. At most one attempt every 5 minutes.
$libraryMisses = 0
$driveRestartedAt = [datetime]::MinValue
function Repair-LibraryMount {
  if (-not $cfg.waitForPath) { return }
  if (Test-Path -LiteralPath $cfg.waitForPath) {
    if ($script:libraryMisses -ge 3) { Say "library path is back: $($cfg.waitForPath)" }
    $script:libraryMisses = 0
    return
  }
  $script:libraryMisses++
  if ($script:libraryMisses -ne 3 -and ($script:libraryMisses % 30) -ne 0) { return }
  if (((Get-Date) - $script:driveRestartedAt).TotalMinutes -lt 5) { return }
  $driveDir = Join-Path $env:ProgramFiles 'Google\Drive File Stream'
  $exe = Get-ChildItem $driveDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+(\.\d+)+$' -and (Test-Path (Join-Path $_.FullName 'GoogleDriveFS.exe')) } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  if (-not $exe) { Say "library path missing and Google Drive for Desktop not found: $($cfg.waitForPath)"; return }
  Say "library path missing ($($cfg.waitForPath)) - restarting Google Drive"
  $script:driveRestartedAt = Get-Date
  Get-Process GoogleDriveFS -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  try { Start-Process -FilePath (Join-Path $exe.FullName 'GoogleDriveFS.exe') } catch { Say "could not start Google Drive: $($_.Exception.Message)" }
}

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
    if ($part.name -eq 'tunnel' -and (Test-Path -LiteralPath $tunnelOff)) {
      if ($p -and -not $p.HasExited) { Say 'tunnel.off: stopping this PC''s tunnel (the NAS serves the site)'; try { $p.Kill() } catch { } }
      $procs[$part.name] = $null
      continue
    }
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
  Repair-LibraryMount
  Start-Sleep -Seconds 10
}
