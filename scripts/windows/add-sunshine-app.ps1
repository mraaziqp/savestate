# Adds "SaveState" to Sunshine's apps, so Moonlight (on a phone, tablet, TV or
# Vita) can open SaveState's Big Picture on this PC and play ANY game in the
# library, PS2, GameCube and PS3 included, with the device's own controls.
#
# Sunshine's settings live under Program Files, so this asks Windows for
# permission once (UAC), adds the entry (keeping every app already there),
# copies the SaveState icon in and restarts the Sunshine service.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\add-sunshine-app.ps1
param([string]$Site = 'https://savestate.co.za')

$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Site', $Site)
  exit
}

$sunshine = Join-Path $env:ProgramFiles 'Sunshine'
$appsFile = Join-Path $sunshine 'config\apps.json'
if (-not (Test-Path $appsFile)) { Write-Host 'Sunshine is not installed (no config\apps.json). Install it from https://app.lizardbyte.dev/Sunshine first.'; Read-Host 'Press Enter to close'; exit 1 }

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Host 'Microsoft Edge was not found.'; Read-Host 'Press Enter to close'; exit 1 }

# The icon Moonlight shows for the entry.
$icon = Join-Path $sunshine 'assets\savestate.png'
$src = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'dist\pwa-512x512.png'
if (Test-Path $src) { Copy-Item $src $icon -Force } else { Invoke-WebRequest "$Site/pwa-512x512.png" -OutFile $icon -UseBasicParsing }

Copy-Item $appsFile "$appsFile.before-savestate" -Force
$cfg = Get-Content $appsFile -Raw | ConvertFrom-Json
$apps = @($cfg.apps | Where-Object { $_.name -ne 'SaveState' })
# host=1: games start on this PC itself (not copied to it as if it were a
# visitor's PC); bp=1: opens straight into Big Picture.
$apps += [pscustomobject]@{
  'name'        = 'SaveState'
  'cmd'         = "`"$edge`" --app=$Site/?tab=consoles&host=1&bp=1 --start-fullscreen"
  'auto-detach' = 'true'
  'image-path'  = $icon
}
$cfg.apps = $apps
# Without a byte-order mark: Windows PowerShell's "UTF8" adds one, and
# Sunshine then failed to read its app list and didn't start.
[IO.File]::WriteAllText($appsFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
Restart-Service SunshineService -ErrorAction SilentlyContinue
Start-Sleep 3
if ((Get-Service SunshineService).Status -ne 'Running') { Start-Service SunshineService }
Write-Host ("Sunshine service: " + (Get-Service SunshineService).Status)
Write-Host ''
Write-Host 'Done. In Moonlight, pick this PC and then "SaveState".'
Write-Host 'The first time, sign in to SaveState in the window that opens (once).'
Start-Sleep 4
