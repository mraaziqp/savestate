# SaveState Host for Windows: turns this PC into a SaveState host with one
# command and nothing else to install (no Docker, no database to set up).
# In PowerShell:
#
#   irm https://savestate.co.za/install-host.ps1 | iex
#
# What it does, each step checked:
#   1. Node.js 22 from nodejs.org (checked against nodejs.org's SHA-256 list)
#   2. SaveState from savestate.co.za (checked against its published SHA-256);
#      it brings its own private database (PostgreSQL), used only on this PC
#   3. ffmpeg for streaming (the Windows builds ffmpeg.org links to: BtbN, else gyan.dev)
#   4. asks for your films, music and games folders
#   5. starts SaveState now and every time you sign in to Windows
# Run it again to update; your settings, accounts and library stay.
# No administrator rights are needed. For a scripted install, set any of
# SAVESTATE_MEDIA_DIR, SAVESTATE_MUSIC_DIR, SAVESTATE_GAMES_DIR (no folder
# dialogs then), SAVESTATE_PORT, SAVESTATE_NO_TASK=1 (don't start with
# Windows) and SAVESTATE_NO_BROWSER=1. To remove it:
#   $env:SAVESTATE_UNINSTALL=1; irm https://savestate.co.za/install-host.ps1 | iex

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # downloads are many times faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Base = if ($env:SAVESTATE_FROM) { $env:SAVESTATE_FROM.TrimEnd('/') } else { 'https://savestate.co.za' }
$Dir  = if ($env:SAVESTATE_HOST_DIR) { $env:SAVESTATE_HOST_DIR } else { Join-Path $env:LOCALAPPDATA 'SaveStateHost' }
$Data = Join-Path $Dir 'data'
$CfgFile = Join-Path $Data 'host.json'
$Node = Join-Path $Dir 'node\node.exe'
$HostJs = Join-Path $Dir 'app\host.mjs'
$Task = 'SaveState Home Host'
$Tar = Join-Path $env:SystemRoot 'System32\tar.exe'

function Step($n, $text) { Write-Host ''; Write-Host "[$n/5] $text" -ForegroundColor Cyan }
function Note($text) { Write-Host "      $text" }
function Sha($file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() }
function Fetch($url, $to) { Invoke-WebRequest -Uri $url -OutFile $to -UseBasicParsing }
# A text file, also when the server calls it binary (GitHub sends checksum
# lists as application/octet-stream, which PowerShell hands back as bytes).
function Text($url) { $c = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content; if ($c -is [byte[]]) { [Text.Encoding]::UTF8.GetString($c) } else { [string]$c } }
# Stops a running copy, then waits for everything started from this folder
# (the server, the database) to exit before files are replaced: an update
# once failed because the database was still holding its own files.
function StopHost {
  if ((Test-Path $Node) -and (Test-Path $HostJs)) { & $Node $HostJs --stop | Out-Null }
  for ($i = 0; $i -lt 40; $i++) {
    $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) })
    if ($left.Count -eq 0) { return }
    if ($i -ge 20) { $left | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
    Start-Sleep -Seconds 1
  }
}
function Clear-Folder($path) {
  for ($i = 0; $i -lt 5 -and (Test-Path $path); $i++) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $path) { Start-Sleep -Seconds 2 }
  }
  if (Test-Path $path) { throw "Couldn't replace $path (a file in it is in use). Close anything using it and run this again." }
}

if ($env:SAVESTATE_UNINSTALL -eq '1') {
  StopHost
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'SaveState Host') -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($d in 'app', 'node', 'ffmpeg') { Remove-Item -LiteralPath (Join-Path $Dir $d) -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath (Join-Path $Dir 'start-host.vbs') -Force -ErrorAction SilentlyContinue
  Write-Host "SaveState Host removed. Your accounts and settings are still in $Data (delete that folder to remove them too)."
  return
}

Write-Host 'SaveState Host for Windows' -ForegroundColor Green
Write-Host "Installing into $Dir"
New-Item -ItemType Directory -Force -Path $Dir, $Data | Out-Null
$tmp = Join-Path $env:TEMP ('savestate-host-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
StopHost   # an update replaces the files of a running copy

try {
  # 1. Node.js
  Step 1 'Node.js (nodejs.org)'
  $sums = (Text 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt')
  $line = ($sums -split "`n") | Where-Object { $_ -match '\snode-v[\d.]+-win-x64\.zip\s*$' } | Select-Object -First 1
  if (-not $line) { throw 'nodejs.org did not list a Windows build of Node.js 22.' }
  $want, $name = $line.Trim() -split '\s+'
  $marker = Join-Path $Dir 'node\.build'
  if ((Test-Path $Node) -and (Test-Path $marker) -and ((Get-Content $marker) -eq $name)) {
    Note "already have $name"
  } else {
    $z = Join-Path $tmp $name
    Fetch "https://nodejs.org/dist/latest-v22.x/$name" $z
    if ((Sha $z) -ne $want) { throw "The Node.js download didn't match nodejs.org's checksum; nothing was changed." }
    & $Tar -xf $z -C $tmp
    Clear-Folder (Join-Path $Dir 'node')
    Move-Item -LiteralPath (Join-Path $tmp ($name -replace '\.zip$', '')) -Destination (Join-Path $Dir 'node')
    Set-Content -LiteralPath $marker -Value $name
    Note "installed $name"
  }

  # 2. SaveState
  Step 2 'SaveState (savestate.co.za)'
  $info = Invoke-RestMethod "$Base/api/downloads/host-info"
  $z = Join-Path $tmp $info.file
  Fetch ($Base + $info.url) $z
  if ((Sha $z) -ne $info.sha256) { throw "The SaveState download didn't match its published checksum; nothing was changed." }
  $app = Join-Path $Dir 'app'
  Clear-Folder $app
  New-Item -ItemType Directory -Path $app | Out-Null
  & $Tar -xf $z -C $app
  if (-not (Test-Path $HostJs)) { throw 'The SaveState download was incomplete.' }
  Note "installed SaveState $($info.version) ($([math]::Round($info.size / 1MB)) MB)"

  # 3. ffmpeg
  Step 3 'ffmpeg for streaming (ffmpeg.org builds)'
  $ff = Join-Path $Dir 'ffmpeg'
  if (Test-Path (Join-Path $ff 'ffmpeg.exe')) {
    Note 'already installed'
  } else {
    $z = Join-Path $tmp 'ffmpeg.zip'
    # Both builds are the ones ffmpeg.org links to for Windows. BtbN (GitHub)
    # first: gyan.dev turned scripted downloads away (HTTP 503) on 2026-11-08.
    $got = $false
    try {
      $rel = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
      $list = (Text "$rel/checksums.sha256") -split "`n" |
        Where-Object { $_ -match '^([0-9a-f]{64})\s+(ffmpeg-n([\d.]+)-latest-win64-gpl-[\d.]+\.zip)\s*$' } |
        ForEach-Object { [pscustomobject]@{ sha = $Matches[1]; file = $Matches[2]; ver = [version]$Matches[3] } } |
        Sort-Object ver -Descending
      $pick = $list | Select-Object -First 1
      Fetch "$rel/$($pick.file)" $z
      if ((Sha $z) -ne $pick.sha) { throw 'checksum' }
      $got = $true
      Note "from BtbN ($($pick.file))"
    } catch { Note 'BtbN unavailable; trying gyan.dev' }
    if (-not $got) {
      Fetch 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $z
      $wantFf = ((Text 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256') -split '\s+')[0].Trim().ToLower()
      if ((Sha $z) -ne $wantFf) { throw "The ffmpeg download didn't match its published checksum; nothing was changed." }
    }
    & $Tar -xf $z -C $tmp
    $bin = Get-ChildItem -Path $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path $ff | Out-Null
    Copy-Item -LiteralPath $bin.FullName, (Join-Path $bin.DirectoryName 'ffprobe.exe') -Destination $ff
    Note 'installed'
  }

  # 4. Folders and port
  Step 4 'Your folders'
  $cfg = if (Test-Path $CfgFile) { (Get-Content $CfgFile -Raw).TrimStart([char]0xFEFF) | ConvertFrom-Json } else { New-Object psobject }
  Add-Type -AssemblyName System.Windows.Forms
  $preset = @{ mediaDir = $env:SAVESTATE_MEDIA_DIR; musicDir = $env:SAVESTATE_MUSIC_DIR; gamesDir = $env:SAVESTATE_GAMES_DIR }
  $scripted = [bool]($env:SAVESTATE_MEDIA_DIR -or $env:SAVESTATE_MUSIC_DIR -or $env:SAVESTATE_GAMES_DIR)
  function Pick($key, $what) {
    $now = $cfg.$key
    if ($scripted) {
      if ($preset[$key]) { $now = $preset[$key] }
      $cfg | Add-Member -NotePropertyName $key -NotePropertyValue $now -Force
      Note ("{0,-14} {1}" -f "${what}:", $(if ($now) { $now } else { '(none yet)' }))
      return
    }
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = "SaveState: choose your $what folder (Cancel to skip$(if ($now) { ', keeping ' + $now }))"
    if ($now -and (Test-Path $now)) { $d.SelectedPath = $now }
    if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $now = $d.SelectedPath }
    $cfg | Add-Member -NotePropertyName $key -NotePropertyValue $now -Force
    Note ("{0,-14} {1}" -f "${what}:", $(if ($now) { $now } else { '(none yet; add it later in SaveState)' }))
  }
  Pick 'mediaDir' 'Films & shows'
  Pick 'musicDir' 'Music'
  Pick 'gamesDir' 'Games (ROMs)'
  $port = if ($env:SAVESTATE_PORT) { [int]$env:SAVESTATE_PORT } elseif ($cfg.port) { [int]$cfg.port } else { 3000 }
  # Keep the port this host had; on a first install, the first free one from 3000.
  if (-not $cfg.port -and -not $env:SAVESTATE_PORT) {
    while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port++ }
  }
  $cfg | Add-Member -NotePropertyName port -NotePropertyValue $port -Force
  # Without a byte-order mark (Set-Content -Encoding UTF8 adds one).
  [IO.File]::WriteAllText($CfgFile, ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
  Note "web address:   http://localhost:$port"

  # 5. Start now and at every sign-in (hidden: no console window)
  Step 5 'Starting SaveState'
  $vbs = Join-Path $Dir 'start-host.vbs'
  Set-Content -LiteralPath $vbs -Encoding ASCII -Value ('CreateObject("WScript.Shell").Run """' + $Node + '"" ""' + $HostJs + '""", 0, False')
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  if ($env:SAVESTATE_NO_TASK -ne '1') { Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Description 'SaveState Host: films, music and games for your devices' -Force | Out-Null }
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`""
  # Buttons instead of commands: Start menu > SaveState Host > Open, Update, Uninstall.
  if ($env:SAVESTATE_NO_TASK -ne '1') {
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'SaveState Host'
    New-Item -ItemType Directory -Force -Path $menu | Out-Null
    $sh = New-Object -ComObject WScript.Shell
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $get = "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm $Base/install-host.ps1 | iex"
    $make = {
      param($name, $target, $arguments, $icon)
      $l = $sh.CreateShortcut((Join-Path $menu "$name.lnk"))
      $l.TargetPath = $target; $l.Arguments = $arguments
      if ($icon) { $l.IconLocation = $icon }
      $l.Save()
    }
    & $make 'Open SaveState' "http://localhost:$port" '' ''
    & $make 'Update SaveState Host' $ps "-NoProfile -ExecutionPolicy Bypass -Command `"$get; pause`"" "$ps,0"
    & $make 'Uninstall SaveState Host' $ps "-NoProfile -ExecutionPolicy Bypass -Command `"`$env:SAVESTATE_UNINSTALL='1'; $get; pause`"" "$ps,0"
  }
  $up = $false
  for ($i = 0; $i -lt 90 -and -not $up; $i++) {
    Start-Sleep -Seconds 2
    try { $up = (Invoke-WebRequest "http://localhost:$port/api/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
  }
  if (-not $up) { throw "SaveState didn't start. Its log is in $Data\logs (host.log and server.log)." }

  # Phones and TVs on your Wi-Fi need the port open; that one step needs admin.
  # The address on the network with the internet router (not a virtual WSL or
  # Hyper-V adapter, which phones can't reach).
  $lan = (Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1).IPv4Address.IPAddress
  if ($lan -is [array]) { $lan = $lan[0] }
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if ($admin) {
    if (-not (Get-NetFirewallRule -DisplayName 'SaveState Host' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName 'SaveState Host' -Direction Inbound -Protocol TCP -LocalPort $port -Profile Private -Action Allow | Out-Null
    }
  }

  Write-Host ''
  Write-Host 'SaveState is running.' -ForegroundColor Green
  Write-Host "  On this PC:          http://localhost:$port"
  if ($lan) { Write-Host "  Phones and TVs:      http://${lan}:$port  (same Wi-Fi)" }
  if (-not $admin -and $lan) { Write-Host '  If other devices cannot connect, allow SaveState when Windows asks about the firewall, or run this once as administrator.' }
  Write-Host '  The first account you create becomes the owner.'
  if ($env:SAVESTATE_NO_BROWSER -ne '1') { Start-Process "http://localhost:$port" }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
