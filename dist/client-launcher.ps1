# NexusEmu Client Launcher v3 (Windows)
# This script runs as a background HTTP server on port 17373.
# It is installed once and then auto-starts at every login via Task Scheduler.
# The browser can wake it silently using the nexusemu:// protocol handler.

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Web -ErrorAction SilentlyContinue

$port           = 17373
$prefix         = "http://127.0.0.1:$port/"
$clientRoot     = Join-Path $env:LOCALAPPDATA "NexusEmuClient"
$romDir         = Join-Path $clientRoot "ROMs"
$emuRoot        = Join-Path $clientRoot "Emulators"
$logsDir        = Join-Path $clientRoot "Logs"
$configPath     = Join-Path $clientRoot "launcher-config.json"
$localScriptPath = Join-Path $clientRoot "client-launcher.ps1"
$lockFile       = Join-Path $clientRoot "launcher.lock"
$versionFile    = Join-Path $clientRoot "launcher-version.txt"

# ── Check if another instance is already running ───────────────────────────────
function Test-LauncherAlreadyRunning {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($r.ok) { return $true }
  } catch { }
  return $false
}

if (Test-LauncherAlreadyRunning) {
  # Already running — exit silently
  exit 0
}

# ── Directory setup ────────────────────────────────────────────────────────────
function Ensure-Dir { param([string]$Path) if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null } }
Ensure-Dir $clientRoot; Ensure-Dir $romDir; Ensure-Dir $emuRoot; Ensure-Dir $logsDir
Ensure-Dir (Join-Path $emuRoot "RetroArch"); Ensure-Dir (Join-Path $emuRoot "PCSX2")
Ensure-Dir (Join-Path $emuRoot "Dolphin"); Ensure-Dir (Join-Path $emuRoot "PPSSPP")

# ── Offline Library ────────────────────────────────────────────────────────────
$offlineDir    = Join-Path $clientRoot "OfflineLibrary"
$offlineMovies = Join-Path $offlineDir "Movies"
$offlineSeries = Join-Path $offlineDir "TV Shows"
$jobsDir       = Join-Path $clientRoot "DownloadJobs"
Ensure-Dir $offlineDir; Ensure-Dir $offlineMovies; Ensure-Dir $offlineSeries; Ensure-Dir $jobsDir

$bgJobs    = @{}   # jobId -> @{ PS; Runspace; AsyncResult } (in-process background download — see Start-MediaDownload)
$videoExts = @('.mp4','.mkv','.avi','.mov','.m4v','.webm','.wmv','.flv')

# Mark any 'downloading' jobs from a previous launcher run as errors (PSJob no longer exists)
Get-ChildItem $jobsDir -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $raw = Get-Content $_.FullName -Raw -Encoding UTF8
    $d   = $raw | ConvertFrom-Json
    if ($d.status -eq 'downloading' -or $d.status -eq 'starting') {
      $d.status = 'error'; $d.error = 'Launcher was restarted — download interrupted'
      $d | ConvertTo-Json -Compress | Set-Content $_.FullName -Encoding UTF8
    }
  } catch {}
}

function Get-OfflineLibraryItems {
  $items = @()
  Get-ChildItem $offlineMovies -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $videoExts -contains $_.Extension.ToLower() } | ForEach-Object {
      $items += [PSCustomObject]@{ kind='movie'; title=$_.BaseName; filename=$_.Name; path=$_.FullName; size=$_.Length; modified=$_.LastWriteTime.ToString('o') }
    }
  Get-ChildItem $offlineSeries -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $videoExts -contains $_.Extension.ToLower() } | ForEach-Object {
      $rel = $_.FullName.Substring($offlineSeries.Length).TrimStart('\').Split('\')
      $seriesT = if ($rel.Count -gt 1) { $rel[0] } else { $_.BaseName }
      $items += [PSCustomObject]@{ kind='series'; title=$_.BaseName; seriesTitle=$seriesT; filename=$_.Name; path=$_.FullName; size=$_.Length; modified=$_.LastWriteTime.ToString('o') }
    }
  return ,$items
}

function Get-AllJobStatuses {
  $out = @{}
  Get-ChildItem $jobsDir -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $raw  = Get-Content $_.FullName -Raw -Encoding UTF8
      $data = $raw | ConvertFrom-Json
      $id   = $_.BaseName
      if ($bgJobs.ContainsKey($id)) {
        $j = $bgJobs[$id]
        if ($j.AsyncResult.IsCompleted -and $data.status -eq 'downloading') {
          $data.status = if ($j.PS.HadErrors) { 'error' } else { 'done' }
          if ($data.status -eq 'done') { $data.pct = 100 }
          $data | ConvertTo-Json -Compress | Set-Content $_.FullName -Encoding UTF8
        }
      }
      $out[$id] = $data
    } catch {}
  }
  return $out
}

function Start-MediaDownload { param($JobId,$Url,$Dest,$Title)
  $pf = Join-Path $jobsDir "$JobId.json"
  [PSCustomObject]@{ id=$JobId; title=$Title; status='starting'; pct=0; done=0; total=0; dest=$Dest; startedAt=(Get-Date).ToString('o') } |
    ConvertTo-Json -Compress | Set-Content $pf -Encoding UTF8
  # Runs on a background thread inside THIS process via a separate Runspace,
  # instead of Start-Job. Start-Job hosts its script in a brand-new powershell.exe
  # CHILD PROCESS — spawning that process briefly flashes a visible console
  # window on screen every single time a download starts, which is exactly what
  # "PowerShell keeps popping up" while using this launcher was. A Runspace is a
  # thread, not a process, so nothing new ever appears on screen.
  $scriptBlock = {
    param($Id,$Url,$Dest,$PF,$Title)
    try {
      $total = 0L
      try {
        $hr = [System.Net.HttpWebRequest]::Create($Url); $hr.Method='HEAD'; $hr.Timeout=10000
        $hr.UserAgent = 'NexusEmuLauncher/3'
        $hrr = $hr.GetResponse(); $total = $hrr.ContentLength; $hrr.Close()
      } catch {}
      $tmpDest = "$Dest.nexusdl"
      $parentDir = Split-Path $Dest -Parent
      if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }
      $hr2 = [System.Net.HttpWebRequest]::Create($Url)
      $hr2.Timeout = -1; $hr2.ReadWriteTimeout = 1800000
      $hr2.UserAgent = 'NexusEmuLauncher/3'
      $hrr2 = $hr2.GetResponse()
      if ($total -le 0) { $total = $hrr2.ContentLength }
      $rs  = $hrr2.GetResponseStream()
      $fs  = [System.IO.File]::Create($tmpDest)
      $buf = New-Object byte[] 131072
      $done = 0L; $lastUpdate = [DateTime]::UtcNow
      while ($true) {
        $n = $rs.Read($buf, 0, $buf.Length)
        if ($n -eq 0) { break }
        $fs.Write($buf, 0, $n); $done += $n
        if (([DateTime]::UtcNow - $lastUpdate).TotalSeconds -ge 1) {
          $pct = if ($total -gt 0) { [math]::Min(99, [int](($done/$total)*100)) } else { -1 }
          @{id=$Id;title=$Title;status='downloading';pct=$pct;done=$done;total=$total;dest=$Dest} | ConvertTo-Json -Compress | Set-Content $PF -Encoding UTF8
          $lastUpdate = [DateTime]::UtcNow
        }
      }
      $fs.Close(); $rs.Close(); $hrr2.Close()
      Move-Item -Path $tmpDest -Destination $Dest -Force
      @{id=$Id;title=$Title;status='done';pct=100;done=$done;total=$total;dest=$Dest} | ConvertTo-Json -Compress | Set-Content $PF -Encoding UTF8
    } catch {
      if ($null -ne $fs) { try { $fs.Close() } catch {} }
      if (Test-Path "$Dest.nexusdl") { Remove-Item "$Dest.nexusdl" -Force -ErrorAction SilentlyContinue }
      @{id=$Id;title=$Title;status='error';pct=0;done=0;total=0;error=[string]$_.Exception.Message;dest=$Dest} | ConvertTo-Json -Compress | Set-Content $PF -Encoding UTF8
    }
  }
  $runspace = [runspacefactory]::CreateRunspace()
  $runspace.Open()
  $ps = [powershell]::Create()
  $ps.Runspace = $runspace
  [void]$ps.AddScript($scriptBlock).AddArgument($JobId).AddArgument($Url).AddArgument($Dest).AddArgument($pf).AddArgument($Title)
  $asyncResult = $ps.BeginInvoke()
  $bgJobs[$JobId] = [PSCustomObject]@{ PS = $ps; Runspace = $runspace; AsyncResult = $asyncResult }
}

# ── Config ─────────────────────────────────────────────────────────────────────
function Save-DefaultConfig {
  $d = [ordered]@{ version=1; createdAt=(Get-Date).ToString('o'); clientRoot=$clientRoot; romDirectory=$romDir; emulatorRoot=$emuRoot
    emulators=[ordered]@{ retroarch=""; dolphin=""; pcsx2=""; ppsspp=""; cemu=""; rpcs3="" } }
  ($d | ConvertTo-Json -Depth 8) | Set-Content $configPath -Encoding UTF8; return $d }
function Load-Config { if (-not (Test-Path $configPath)) { return Save-DefaultConfig }
  try { $r = Get-Content $configPath -Raw -Encoding UTF8; return ($r | ConvertFrom-Json) } catch { return Save-DefaultConfig } }
function Save-Config { param($C) ($C | ConvertTo-Json -Depth 8) | Set-Content $configPath -Encoding UTF8; return $C }
function Resolve-RomDirectory { param($C) $d=[string]$C.romDirectory; if([string]::IsNullOrWhiteSpace($d)){$d=$romDir}; Ensure-Dir $d; return $d }

# ── HTTP response helper ───────────────────────────────────────────────────────
function Write-JsonResponse { param($Context,$Object,[int]$Status=200)
  $json = ($Object | ConvertTo-Json -Depth 8 -Compress)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $Context.Response.StatusCode = $Status
  $Context.Response.ContentType = 'application/json; charset=utf-8'
  $Context.Response.Headers['Access-Control-Allow-Origin'] = '*'
  $Context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
  $Context.Response.Headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
  $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Context.Response.Close() }

# ── Task Scheduler auto-start (primary method — survives reboots & crashes) ────
function Install-TaskScheduler {
  $taskName = "NexusEmuClientLauncher"
  $ps1 = $localScriptPath
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps1`""
  try {
    # Create: run on logon, restart every 2 minutes if it exits, unlimited duration
    $xml = @"
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT2M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions><Exec><Command>powershell.exe</Command>
    <Arguments>-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$ps1"</Arguments>
  </Exec></Actions>
</Task>
"@
    $xmlPath = Join-Path $clientRoot "launcher-task.xml"
    [System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)
    schtasks /create /tn $taskName /xml $xmlPath /f 2>&1 | Out-Null
    Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
    return @{ ok=($LASTEXITCODE -eq 0); method='scheduler'; taskName=$taskName }
  } catch { }
  # Fallback: Startup folder
  try {
    $startupDir = [Environment]::GetFolderPath('Startup')
    $startupCmd = Join-Path $startupDir "NexusEmuClientLauncher.cmd"
    "@echo off`r`nPowerShell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1`"`r`n" | Set-Content $startupCmd -Encoding ASCII
    return @{ ok=$true; method='startup-folder'; path=$startupCmd }
  } catch { return @{ ok=$false; method='none' } }
}

# ── nexusemu:// protocol handler (allows browser to wake this launcher) ────────
function Install-ProtocolHandler {
  $key = "HKCU:\Software\Classes\nexusemu"
  try {
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(default)" -Value "URL:NexusEmu Client Launcher"
    Set-ItemProperty -Path $key -Name "URL Protocol" -Value ""
    New-Item -Path "$key\shell\open\command" -Force | Out-Null
    $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$localScriptPath`""
    Set-ItemProperty -Path "$key\shell\open\command" -Name "(default)" -Value $cmd
    return @{ ok=$true; protocol="nexusemu://" }
  } catch { return @{ ok=$false; error=$_.Exception.Message } }
}

# ── Self-update from host server ───────────────────────────────────────────────
function Try-SelfUpdate {
  # Read preferred host URL from config
  $hostUrlFile = Join-Path $clientRoot "preferred-host-url.txt"
  if (-not (Test-Path $hostUrlFile)) { return }
  $hostUrl = (Get-Content $hostUrlFile -Raw -Encoding UTF8).Trim()
  if ([string]::IsNullOrWhiteSpace($hostUrl)) { return }
  try {
    $updateUrl = "$hostUrl/api/client-launcher/raw"
    $tmp = Join-Path $clientRoot "client-launcher-update.ps1"
    Invoke-WebRequest -Uri $updateUrl -OutFile $tmp -UseBasicParsing -TimeoutSec 10 | Out-Null
    if ((Test-Path $tmp) -and (Get-Item $tmp).Length -gt 1000) {
      Copy-Item -Path $tmp -Destination $localScriptPath -Force
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    }
  } catch { } # silently ignore — offline or unreachable host
}

# ── Sync script to AppData and run setup ──────────────────────────────────────
if ($PSCommandPath -and (Test-Path $PSCommandPath) -and $PSCommandPath -ne $localScriptPath) {
  Copy-Item -Path $PSCommandPath -Destination $localScriptPath -Force -ErrorAction SilentlyContinue
}
Try-SelfUpdate
$autostart  = Install-TaskScheduler
$protoSetup = Install-ProtocolHandler

# Mark installed for web app detection
"installed" | Set-Content (Join-Path $clientRoot "installed.flag") -Encoding ASCII

# ── Emulator path resolution ───────────────────────────────────────────────────
$PLATFORM_CORES = @{
  'nes'='fceumm'; 'famicom'='fceumm'; 'snes'='snes9x'; 'n64'='mupen64plus_next';
  'gba'='mgba'; 'gbc'='mgba'; 'gb'='mgba'; 'nds'='desmume'; '3ds'='citra';
  'ps1'='pcsx_rearmed'; 'psx'='pcsx_rearmed'; 'playstation'='pcsx_rearmed';
  'ps2'='pcsx2'; 'psp'='ppsspp';
  'genesis'='genesis_plus_gx'; 'megadrive'='genesis_plus_gx'; 'sega genesis'='genesis_plus_gx';
  'gamegear'='genesis_plus_gx'; 'mastersystem'='genesis_plus_gx'; 'sms'='genesis_plus_gx';
  'sega32x'='picodrive'; '32x'='picodrive';
  'segacd'='genesis_plus_gx'; 'sega cd'='genesis_plus_gx';
  'dreamcast'='flycast'; 'sega dreamcast'='flycast'; 'saturn'='yabause'; 'sega saturn'='yabause';
  'pce'='mednafen_pce'; 'pc engine'='mednafen_pce'; 'turbografx'='mednafen_pce';
  'wonderswan'='mednafen_wswan'; 'neogeo'='fbneo'; 'neo geo'='fbneo';
  'atari2600'='stella'; 'atari 2600'='stella'; 'atari7800'='prosystem'; 'atari 7800'='prosystem';
  'lynx'='mednafen_lynx'; 'mame'='mame'; 'arcade'='mame';
}

function Get-EmulatorPath { param([string]$platform)
  $cfg = Load-Config; $p = $platform.ToLowerInvariant()
  $retroCandidates = @([string]$cfg.emulators.retroarch,
    (Join-Path $emuRoot "RetroArch\retroarch.exe"),
    "$env:LOCALAPPDATA\RetroArch\retroarch.exe",
    "C:\RetroArch\retroarch.exe",
    "C:\Program Files\RetroArch-Win64\retroarch.exe",
    "C:\Program Files (x86)\RetroArch-Win64\retroarch.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  $dolphinCandidates = @([string]$cfg.emulators.dolphin,
    (Join-Path $emuRoot "Dolphin\Dolphin.exe"),
    "C:\Program Files\Dolphin\Dolphin.exe",
    "C:\Program Files\Dolphin Emulator\Dolphin.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  $pcsx2Candidates = @([string]$cfg.emulators.pcsx2,
    (Join-Path $emuRoot "PCSX2\pcsx2-qt.exe"),
    (Join-Path $emuRoot "PCSX2\pcsx2.exe"),
    "C:\Program Files\PCSX2\pcsx2-qt.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  $ppssppCandidates = @([string]$cfg.emulators.ppsspp,
    (Join-Path $emuRoot "PPSSPP\PPSSPPWindows64.exe"),
    "C:\Program Files\PPSSPP\PPSSPPWindows64.exe"
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($p -in @('gamecube','wii','wiiu') -and $dolphinCandidates) { return $dolphinCandidates }
  if ($p -eq 'ps2' -and $pcsx2Candidates) { return $pcsx2Candidates }
  if ($p -eq 'psp' -and $ppssppCandidates) { return $ppssppCandidates }
  if ($retroCandidates) { return $retroCandidates }
  if ($p -in @('gamecube','wii') -and $dolphinCandidates) { return $dolphinCandidates }
  if ($p -eq 'ps2' -and $pcsx2Candidates) { return $pcsx2Candidates }
  return $null }

function Get-CorePath { param([string]$RetroArchPath,[string]$Platform)
  $p = $Platform.ToLowerInvariant()
  if (-not $PLATFORM_CORES.ContainsKey($p)) { return $null }
  $coreId = $PLATFORM_CORES[$p]
  $c = Join-Path (Split-Path $RetroArchPath -Parent) "cores" "${coreId}_libretro.dll"
  if (Test-Path $c) { return $c }; return $null }

function Ensure-RetroArchInstalled {
  $emu = Get-EmulatorPath -platform 'nes'
  if ($emu) { return @{ ok=$true; installed=$false; path=$emu; detail='RetroArch already present' } }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    try {
      Start-Process -FilePath $winget.Source -ArgumentList @('install','-e','--id','Libretro.RetroArch','--accept-source-agreements','--accept-package-agreements','--silent') -Wait -WindowStyle Hidden
      $found = Get-EmulatorPath -platform 'nes'
      if ($found) { return @{ ok=$true; installed=$true; path=$found; detail='RetroArch installed via winget' } }
    } catch { }
  }
  return @{ ok=$false; detail='RetroArch not found. Install from retroarch.com or place in ${emuRoot}\RetroArch\retroarch.exe' } }

function Ensure-RetroArchCore { param([string]$RetroArchPath,[string]$Platform)
  $existing = Get-CorePath -RetroArchPath $RetroArchPath -Platform $Platform
  if ($existing) { return @{ ok=$true; installed=$false; path=$existing; detail='Core already present' } }
  $p = $Platform.ToLowerInvariant()
  if (-not $PLATFORM_CORES.ContainsKey($p)) { return @{ ok=$true; detail="No core mapping for '$Platform'" } }
  $coreId = $PLATFORM_CORES[$p]
  $coreUrl = "https://buildbot.libretro.com/nightly/windows/x86_64/latest/${coreId}_libretro.dll.zip"
  $coresDir = Join-Path (Split-Path $RetroArchPath -Parent) 'cores'; Ensure-Dir $coresDir
  $zipPath = Join-Path $clientRoot "${coreId}_libretro.dll.zip"
  try {
    Invoke-WebRequest -Uri $coreUrl -OutFile $zipPath -UseBasicParsing | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $coresDir -Force
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    $after = Get-CorePath -RetroArchPath $RetroArchPath -Platform $Platform
    if ($after) { return @{ ok=$true; installed=$true; coreId=$coreId; path=$after; detail='Core installed' } }
  } catch { return @{ ok=$false; coreId=$coreId; detail="Core download failed: $($_.Exception.Message)" } }
  return @{ ok=$false; coreId=$coreId; detail='Core install attempted but not detected' } }

function Get-RomExtFromUrl { param([string]$Url)
  try { $n=[System.IO.Path]::GetFileName(([System.Uri]$Url).AbsolutePath); $e=[System.IO.Path]::GetExtension($n); if($e -and $e.Length -le 8){return $e} } catch{}; return ".rom" }

# Turns the host's relative_path (e.g. "SNES/Action/Super Mario World.sfc")
# into a safe subpath under this client's ROM root, mirroring the host's
# actual folder structure instead of flattening everything into
# <romDir>\<platform>\<gameId>.<ext>. Returns $null for anything that looks
# like it could escape the ROM root (drive letters, UNC paths, leading slash,
# ".." segments) so a malformed/hostile value just falls back to the old
# flat layout instead of writing outside the ROM folder.
function Get-SafeRelativeSubpath { param([string]$RelPath)
  if ([string]::IsNullOrWhiteSpace($RelPath)) { return $null }
  $norm = $RelPath.Trim().Replace('/', [IO.Path]::DirectorySeparatorChar).Replace('\\', [IO.Path]::DirectorySeparatorChar)
  if ($norm -match '^[a-zA-Z]:' -or $norm.StartsWith('\\') -or $norm.StartsWith([IO.Path]::DirectorySeparatorChar)) { return $null }
  $sep = [IO.Path]::DirectorySeparatorChar
  $parts = $norm -split [regex]::Escape($sep) | Where-Object { $_ -and $_ -ne '.' }
  if (-not $parts -or ($parts -contains '..')) { return $null }
  return ($parts -join $sep) }

function Download-Rom { param([string]$RomUrl,[string]$SafeName,[string]$GameId,[string]$Platform,[string]$RelativePath)
  $cfg = Load-Config; $dir = Resolve-RomDirectory -C $cfg
  $safeRel = Get-SafeRelativeSubpath -RelPath $RelativePath
  if ($safeRel) {
    $dest = Join-Path $dir $safeRel
    $destDir = Split-Path $dest -Parent
    if ($destDir) { Ensure-Dir $destDir }
  } else {
    # Store in platform subfolder if possible
    if (-not [string]::IsNullOrWhiteSpace($Platform)) {
      $sub = Join-Path $dir $Platform.ToLowerInvariant(); Ensure-Dir $sub; $dir = $sub }
    $ext = Get-RomExtFromUrl -Url $RomUrl
    $base = if ($GameId) { $GameId } else { $SafeName }
    $dest = Join-Path $dir "$base$ext"
  }
  Invoke-WebRequest -Uri $RomUrl -OutFile $dest -UseBasicParsing | Out-Null
  return @{ ok=$true; file=$dest; romDirectory=(Split-Path $dest -Parent) } }

# ── Start HTTP listener ────────────────────────────────────────────────────────
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
  # Port in use — likely already running, exit silently
  exit 0 }

$cfg = Load-Config

# ── Request loop ──────────────────────────────────────────────────────────────
while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
    $req = $context.Request
    $path = $req.Url.AbsolutePath.ToLowerInvariant()

    # CORS preflight
    if ($req.HttpMethod -eq 'OPTIONS') {
      $context.Response.StatusCode = 204
      $context.Response.Headers['Access-Control-Allow-Origin'] = '*'
      $context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
      $context.Response.Headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
      $context.Response.Close(); continue }

    # ── /health ── basic liveness ────────────────────────────────────────────
    if ($req.HttpMethod -eq 'GET' -and $path -in @('/health','/wake','/')) {
      $cfg = Load-Config
      $retroPath = Get-EmulatorPath -platform 'nes'
      $dolphinPath = Get-EmulatorPath -platform 'gamecube'
      $pcsx2Path = Get-EmulatorPath -platform 'ps2'
      Write-JsonResponse -Context $context -Object @{
        ok=$true; port=$port; version=3
        clientRoot=$clientRoot; romDirectory=(Resolve-RomDirectory -C $cfg)
        emulatorRoot=$emuRoot
        retroarchFound=[bool]$retroPath; dolphinFound=[bool]$dolphinPath; pcsx2Found=[bool]$pcsx2Path
        autostart=[bool]$autostart.ok; autostartMethod=[string]$autostart.method
        protocolHandler=[bool]$protoSetup.ok
      }; continue }

    # ── /preflight ── per-platform readiness check ──────────────────────────
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/preflight') {
      $cfg = Load-Config; $platform = [string]$req.QueryString['platform']
      if (-not $platform) { $platform = 'nes' }
      $emu = Get-EmulatorPath -platform $platform
      $hasEmu = $emu -and (Test-Path $emu)
      $corePath = if ($hasEmu -and ([System.IO.Path]::GetFileName($emu).ToLowerInvariant() -eq 'retroarch.exe')) { Get-CorePath -RetroArchPath $emu -Platform $platform } else { $null }
      Write-JsonResponse -Context $context -Object @{
        ok=$true; platform=$platform; launcherRunning=$true
        emulatorFound=[bool]$hasEmu; emulatorPath=(if($hasEmu){$emu}else{$null})
        coreRequired=[bool]($hasEmu -and ([System.IO.Path]::GetFileName($emu).ToLowerInvariant() -eq 'retroarch.exe'))
        coreFound=[bool]$corePath; corePath=(if($corePath){$corePath}else{$null})
        romDirectory=(Resolve-RomDirectory -C $cfg)
        autostart=[bool]$autostart.ok
      }; continue }

    # ── /manual-setup-info ── last-resort fallback when auto-setup fails ────
    # Tells the UI exactly which folders to drop ROM/emulator files into so
    # the existing /launch and /preflight lookups pick them up on the next
    # attempt — this never downloads anything itself, only reports paths.
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/manual-setup-info') {
      $cfg = Load-Config
      $platform = [string]$req.QueryString['platform']
      $relativePath = [string]$req.QueryString['relativePath']
      $gameId = [string]$req.QueryString['gameId']
      $title = [string]$req.QueryString['title']
      $safeName = ($title -replace '[\/:*?"<>|\\]','_'); if (-not $safeName) { $safeName='nexus_game' }
      $baseDir = Resolve-RomDirectory -C $cfg
      $dir = $baseDir
      if ($platform) { $sub=Join-Path $dir $platform.ToLowerInvariant(); Ensure-Dir $sub; $dir=$sub }
      $safeRel = Get-SafeRelativeSubpath -RelPath $relativePath
      $mirroredFile = if ($safeRel) { Join-Path $baseDir $safeRel } else { $null }
      $existing = $null
      if ($mirroredFile -and (Test-Path $mirroredFile)) { $existing = $mirroredFile }
      if (-not $existing -and $gameId) { $f=Get-ChildItem $dir -File -ErrorAction SilentlyContinue | Where-Object {$_.BaseName -eq $gameId} | Select-Object -First 1; if($f){$existing=$f.FullName} }
      if (-not $existing) { $f=Get-ChildItem $dir -File -ErrorAction SilentlyContinue | Where-Object {$_.BaseName -eq $safeName} | Select-Object -First 1; if($f){$existing=$f.FullName} }
      Write-JsonResponse -Context $context -Object @{
        ok=$true
        romTargetPath=$mirroredFile
        romFallbackFolder=$dir
        romFallbackNameHint="$(if($gameId){$gameId}else{$safeName}).<file extension, e.g. .zip, .sfc, .iso>"
        romFound=[bool]$existing
        romFoundAt=$existing
        emulatorRoot=$emuRoot
      }; continue }

    # ── /setup ── full status object ────────────────────────────────────────
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/setup') {
      $cfg = Load-Config
      Write-JsonResponse -Context $context -Object @{
        success=$true; clientRoot=$clientRoot
        romDirectory=(Resolve-RomDirectory -C $cfg); emulatorRoot=$emuRoot
        emulators=@{
          retroarch=(Get-EmulatorPath -platform 'nes')
          dolphin=(Get-EmulatorPath -platform 'gamecube')
          pcsx2=(Get-EmulatorPath -platform 'ps2')
          ppsspp=(Get-EmulatorPath -platform 'psp')
        }
        autostart=$autostart; protocolHandler=$protoSetup
      }; continue }

    # ── POST body reader helper ──────────────────────────────────────────────
    function Read-Body { param($Request)
      $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
      $raw = $reader.ReadToEnd(); $reader.Close()
      try { return ($raw | ConvertFrom-Json) } catch {
        try { return [System.Web.HttpUtility]::ParseQueryString($raw) } catch { return @{} } } }

    # ── /cache-rom ── download ROM to local folder ──────────────────────────
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/cache-rom') {
      $body = Read-Body $req
      $romUrl = [string]($body.romUrl ?? $body['romUrl'])
      $title  = [string]($body.title  ?? $body['title'])
      $gameId = [string]($body.gameId ?? $body['gameId'])
      $platform=[string]($body.platform?? $body['platform'])
      $relativePath=[string]($body.relativePath ?? $body['relativePath'])
      if (-not $romUrl) { Write-JsonResponse -Context $context -Object @{success=$false;error='romUrl required'} -Status 400; continue }
      $safeName = ($title -replace '[\/:*?"<>|\\]','_') -replace '\s+',' '
      if (-not $safeName) { $safeName = 'nexus_game' }
      try {
        $r = Download-Rom -RomUrl $romUrl -SafeName $safeName -GameId $gameId -Platform $platform -RelativePath $relativePath
        Write-JsonResponse -Context $context -Object @{success=$true;cached=$true;file=$r.file;romDirectory=$r.romDirectory}
      } catch {
        Write-JsonResponse -Context $context -Object @{success=$false;error="Download failed: $($_.Exception.Message)"} -Status 500 }
      continue }

    # ── /ensure-local ── install emulator + core if needed ──────────────────
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/ensure-local') {
      $body = Read-Body $req; $platform=[string]($body.platform ?? 'nes')
      $steps = @()
      $emu = Get-EmulatorPath -platform $platform
      if (-not $emu) {
        $r = Ensure-RetroArchInstalled; $steps += @{name='RetroArch';ok=[bool]$r.ok;detail=[string]$r.detail}
        if ($r.ok) { $emu = [string]$r.path }
      } else { $steps += @{name='RetroArch';ok=$true;detail="Found: $emu"} }
      $coreOk=$true; $corePath=$null
      if ($emu -and ([System.IO.Path]::GetFileName($emu).ToLowerInvariant() -eq 'retroarch.exe')) {
        $r = Ensure-RetroArchCore -RetroArchPath $emu -Platform $platform
        $coreOk=[bool]$r.ok; $corePath=[string]$r.path
        $steps += @{name='Core';ok=[bool]$r.ok;detail=[string]$r.detail}
      } else { $steps += @{name='Core';ok=$true;detail='Not required for this emulator'} }
      $ok = ($emu -and (Test-Path $emu) -and $coreOk)
      Write-JsonResponse -Context $context -Object @{ok=[bool]$ok;platform=$platform;emulatorPath=(if($emu){$emu}else{$null});corePath=(if($corePath){$corePath}else{$null});steps=$steps}
      continue }

    # ── /install-emulator ── auto-install specific emulator ─────────────────
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/install-emulator') {
      $body = Read-Body $req; $target=[string]($body.emulator ?? 'retroarch')
      $result = switch ($target.ToLowerInvariant()) {
        'retroarch' { Ensure-RetroArchInstalled }
        default { @{ok=$false;detail="Unknown emulator '$target'. Supported: retroarch"} }
      }
      Write-JsonResponse -Context $context -Object $result; continue }

    # ── /config ── update configuration ─────────────────────────────────────
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/config') {
      $body = Read-Body $req; $cfg = Load-Config
      if ($body.romDirectory) { $cfg.romDirectory = [string]$body.romDirectory }
      if ($body.emulators) {
        if (-not $cfg.emulators) { $cfg | Add-Member -MemberType NoteProperty -Name emulators -Value @{} -Force }
        foreach ($k in @('retroarch','dolphin','pcsx2','ppsspp','cemu','rpcs3')) {
          $v = [string]$body.emulators.$k; if ($v) { $cfg.emulators.$k = $v } } }
      # Persist preferred host URL for self-updates — only allow from localhost or the already-configured host
      if ($body.preferredHostUrl) {
        $reqOrigin = [string]$req.Headers['Origin']
        $hostUrlFile = Join-Path $clientRoot "preferred-host-url.txt"
        $currentHost = if (Test-Path $hostUrlFile) { (Get-Content $hostUrlFile -Raw -Encoding UTF8).Trim() } else { "" }
        $originOk = (-not $reqOrigin) -or
                    ($reqOrigin -match '^https?://(localhost|127\.0\.0\.1)(:\d+)?$') -or
                    ($currentHost -and $reqOrigin.StartsWith($currentHost))
        if ($originOk) {
          [string]$body.preferredHostUrl | Set-Content $hostUrlFile -Encoding ASCII
        }
      }
      $saved = Save-Config $cfg
      Write-JsonResponse -Context $context -Object @{ok=$true;romDirectory=(Resolve-RomDirectory -C $saved)}
      continue }

    # ── /launch ── download ROM if needed, then launch emulator ─────────────
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/launch') {
      $body = Read-Body $req
      $romUrl  = [string]($body.romUrl  ?? $body['romUrl'])
      $platform= [string]($body.platform?? $body['platform'])
      $title   = [string]($body.title   ?? $body['title'])
      $gameId  = [string]($body.gameId  ?? $body['gameId'])
      $relativePath = [string]($body.relativePath ?? $body['relativePath'])
      $safeName = ($title -replace '[\/:*?"<>|\\]','_'); if (-not $safeName) { $safeName='nexus_game' }
      $cfg = Load-Config; $baseDir = Resolve-RomDirectory -C $cfg
      # Mirror the host's real folder structure when we know it, instead of
      # always flattening into <romDir>\<platform>\<gameId>.<ext> — keeps
      # paths consistent between host and client for the same library.
      $safeRel = Get-SafeRelativeSubpath -RelPath $relativePath
      $mirroredFile = $null
      if ($safeRel) {
        $mirroredFile = Join-Path $baseDir $safeRel
        $mirroredDir = Split-Path $mirroredFile -Parent
        if ($mirroredDir) { Ensure-Dir $mirroredDir }
      }
      $dir = $baseDir
      # Platform subfolder (legacy flat layout, used as fallback / for older cached files)
      if ($platform) { $sub=Join-Path $dir $platform.ToLowerInvariant(); Ensure-Dir $sub; $dir=$sub }
      # Check for cached copy — prefer the mirrored path, then fall back to
      # the legacy flat layout so ROMs downloaded before this change are
      # still found instead of being re-downloaded.
      $cachedFile = $null
      if ($mirroredFile -and (Test-Path $mirroredFile)) { $cachedFile = $mirroredFile }
      if (-not $cachedFile -and $gameId) { $f=Get-ChildItem $dir -File -ErrorAction SilentlyContinue | Where-Object {$_.BaseName -eq $gameId} | Select-Object -First 1; if($f){$cachedFile=$f.FullName} }
      if (-not $cachedFile) { $f=Get-ChildItem $dir -File -ErrorAction SilentlyContinue | Where-Object {$_.BaseName -eq $safeName} | Select-Object -First 1; if($f){$cachedFile=$f.FullName} }
      $romFile = $cachedFile
      if (-not $romFile) {
        if (-not $romUrl) { Write-JsonResponse -Context $context -Object @{success=$false;error='romUrl required when no cached ROM exists'} -Status 400; continue }
        if ($mirroredFile) { $romFile = $mirroredFile }
        else { $ext = Get-RomExtFromUrl $romUrl; $base=if($gameId){$gameId}else{$safeName}; $romFile=Join-Path $dir "$base$ext" }
        try { Invoke-WebRequest -Uri $romUrl -OutFile $romFile -UseBasicParsing | Out-Null } catch {
          if ($cachedFile -and (Test-Path $cachedFile)) { $romFile=$cachedFile } else {
            Write-JsonResponse -Context $context -Object @{success=$false;error="ROM download failed: $($_.Exception.Message)"} -Status 500; continue } } }
      $emu = Get-EmulatorPath -platform $platform
      if (-not $emu) { Write-JsonResponse -Context $context -Object @{success=$false;error="No emulator found for '$platform'. Place emulator in $emuRoot\<EmulatorName>\<exe>"} -Status 404; continue }
      try {
        $args = @()
        if ([System.IO.Path]::GetFileName($emu).ToLowerInvariant() -eq 'retroarch.exe') {
          $core = Get-CorePath -RetroArchPath $emu -Platform $platform; if($core){$args+=@('-L',$core)}; $args+=$romFile
        } else { $args+=$romFile }
        Start-Process -FilePath $emu -ArgumentList $args | Out-Null
        Write-JsonResponse -Context $context -Object @{success=$true;launched=$true;file=$romFile;emulator=$emu;usedCache=[bool]$cachedFile}
      } catch { Write-JsonResponse -Context $context -Object @{success=$false;error="Launch failed: $($_.Exception.Message)"} -Status 500 }
      continue }

    # ── /offline-library ── list locally saved files ─────────────────────────
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/offline-library') {
      $items = Get-OfflineLibraryItems
      Write-JsonResponse -Context $context -Object @{ ok=$true; offlineDir=$offlineDir; items=@($items) }
      continue }

    # ── /offline-download ── queue a background download ─────────────────────
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/offline-download') {
      $body    = Read-Body $req
      $url     = [string]($body.url          ?? '')
      $title   = [string]($body.title        ?? 'Unknown')
      $kind    = [string]($body.kind         ?? 'movie')
      $series  = [string]($body.seriesTitle  ?? '')
      $season  = $body.season
      $fname   = [string]($body.filename     ?? ($title -replace '[\/:*?"<>|\\]','_'))
      if (-not $url) { Write-JsonResponse -Context $context -Object @{ok=$false;error='url required'} -Status 400; continue }
      $safeFname  = $fname -replace '[\/:*?"<>|\\]','_'
      $dest = if ($kind -eq 'series' -and $series) {
        $safeS   = $series -replace '[\/:*?"<>|\\]','_'
        $seasonF = if ($null -ne $season -and [string]$season -ne '') { "Season $(([string]$season).PadLeft(2,'0'))" } else { 'Episodes' }
        Join-Path $offlineSeries "$safeS\$seasonF\$safeFname"
      } else { Join-Path $offlineMovies $safeFname }
      $jobId = [System.Guid]::NewGuid().ToString('N').Substring(0,12)
      Start-MediaDownload -JobId $jobId -Url $url -Dest $dest -Title $title
      Write-JsonResponse -Context $context -Object @{ ok=$true; jobId=$jobId; dest=$dest }
      continue }

    # ── /offline-status ── poll all download jobs ─────────────────────────────
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/offline-status') {
      $statuses = Get-AllJobStatuses
      Write-JsonResponse -Context $context -Object @{ ok=$true; jobs=$statuses }
      continue }

    # ── /offline-cancel ── cancel and remove a job ────────────────────────────
    if ($req.HttpMethod -eq 'POST' -and $path -eq '/offline-cancel') {
      $body  = Read-Body $req; $jobId = [string]($body.jobId ?? '')
      if ($bgJobs.ContainsKey($jobId)) {
        try { $bgJobs[$jobId].PS.Stop() } catch {}
        try { $bgJobs[$jobId].PS.Dispose() } catch {}
        try { $bgJobs[$jobId].Runspace.Close() } catch {}
        $bgJobs.Remove($jobId)
      }
      $pf = Join-Path $jobsDir "$jobId.json"
      if (Test-Path $pf) {
        try {
          $d = Get-Content $pf -Raw | ConvertFrom-Json; $d.status = 'cancelled'
          if ($d.dest -and (Test-Path "$($d.dest).nexusdl")) { Remove-Item "$($d.dest).nexusdl" -Force -ErrorAction SilentlyContinue }
          $d | ConvertTo-Json -Compress | Set-Content $pf -Encoding UTF8
        } catch {}
      }
      Write-JsonResponse -Context $context -Object @{ ok=$true }
      continue }

    # ── /offline-file ── serve a local file with byte-range support ───────────
    if ($req.HttpMethod -eq 'GET' -and $path -eq '/offline-file') {
      $filePath = [System.Web.HttpUtility]::UrlDecode([string]$req.QueryString['path'])
      if (-not $filePath -or -not (Test-Path $filePath -PathType Leaf)) {
        $context.Response.StatusCode = 404; $context.Response.Close(); continue }
      # Security: file must be inside the offline library
      try {
        $resolved = (Resolve-Path $filePath -ErrorAction Stop).Path
        $resOff   = (Resolve-Path $offlineDir -ErrorAction Stop).Path.TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($resOff, [System.StringComparison]::OrdinalIgnoreCase)) {
          $context.Response.StatusCode = 403; $context.Response.Close(); continue }
      } catch { $context.Response.StatusCode = 403; $context.Response.Close(); continue }

      $ext  = [System.IO.Path]::GetExtension($filePath).ToLower()
      $mime = switch ($ext) {
        '.mp4'  { 'video/mp4' } '.mkv' { 'video/x-matroska' } '.webm' { 'video/webm' }
        '.avi'  { 'video/x-msvideo' } '.mov' { 'video/quicktime' } '.m4v' { 'video/mp4' }
        '.wmv'  { 'video/x-ms-wmv' } default { 'application/octet-stream' }
      }
      $fi       = Get-Item $filePath
      $totalLen = $fi.Length
      $rangeH   = $req.Headers['Range']
      $resp     = $context.Response
      $resp.ContentType = $mime
      $resp.Headers['Access-Control-Allow-Origin'] = '*'
      $resp.Headers['Accept-Ranges'] = 'bytes'
      $resp.Headers['Cache-Control'] = 'public, max-age=0, no-transform'
      $fs = [System.IO.FileStream]::new($filePath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read)
      try {
        if ($rangeH -match 'bytes=(\d*)-(\d*)') {
          $start  = if ($Matches[1]) { [long]$Matches[1] } else { 0L }
          $endB   = if ($Matches[2]) { [long]$Matches[2] } else { $totalLen - 1 }
          $endB   = [math]::Min($endB, $totalLen - 1)
          $length = $endB - $start + 1
          $resp.StatusCode = 206
          $resp.Headers['Content-Range'] = "bytes $start-$endB/$totalLen"
          $resp.ContentLength64 = $length
          $fs.Seek($start, [System.IO.SeekOrigin]::Begin) | Out-Null
          $buf = New-Object byte[] ([math]::Min(131072L, $length))
          $rem = $length
          while ($rem -gt 0) {
            $n = $fs.Read($buf, 0, [math]::Min($buf.Length, $rem))
            if ($n -eq 0) { break }
            $resp.OutputStream.Write($buf, 0, $n); $rem -= $n
          }
        } else {
          $resp.StatusCode = 200; $resp.ContentLength64 = $totalLen
          $buf = New-Object byte[] 131072
          while ($true) { $n = $fs.Read($buf, 0, $buf.Length); if ($n -eq 0) { break }; $resp.OutputStream.Write($buf, 0, $n) }
        }
      } finally { $fs.Close(); $resp.Close() }
      continue }

    # 404 catch-all
    Write-JsonResponse -Context $context -Object @{success=$false;error='Not found'} -Status 404
  } catch {
    # Silently catch errors to keep the loop running
    try { $context.Response.Close() } catch { }
  }
}
