# Builds the signed Android app on this Windows host and publishes it, so the
# app's "Get the App > Android" button (/api/downloads/apk) offers it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\build-apk.ps1
#
# The app is a thin client that loads the live site (capacitor.config.ts), so
# it only needs rebuilding when the Android shell itself changes.
# Signing: NEXUS_APK_KEYSTORE / NEXUS_APK_KEYSTORE_PASSWORD in .env (alias
# "savestate"). Keep that keystore safe: Android only installs an update
# signed with the same key as the installed app.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

$env_ = @{}
Get-Content (Join-Path $root '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z0-9_]+)=(.*)$') { $env_[$Matches[1]] = $Matches[2].Trim() } }
$keystore = $env_['NEXUS_APK_KEYSTORE']; $storePass = $env_['NEXUS_APK_KEYSTORE_PASSWORD']
if (-not $keystore -or -not (Test-Path $keystore)) { throw 'NEXUS_APK_KEYSTORE is not set in .env or the file is missing' }

# Gradle 8.7 runs on JDK 17-21.
$jdk = @("$env:ProgramFiles\Eclipse Adoptium\jdk-21*", "$env:ProgramFiles\Android\Android Studio\jbr") |
  ForEach-Object { Get-Item $_ -ErrorAction SilentlyContinue } | Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } | Select-Object -First 1
if (-not $jdk) { throw 'No JDK 17-21 found' }
$env:JAVA_HOME = $jdk.FullName
$env:ANDROID_HOME = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
"sdk.dir=$($env:ANDROID_HOME -replace '\\','\\')" | Set-Content -Encoding ascii (Join-Path $root 'android\local.properties')
$buildTools = Get-ChildItem (Join-Path $env:ANDROID_HOME 'build-tools') -Directory | Sort-Object { [version]($_.Name -replace '[^\d.]','') } -Descending | Select-Object -First 1
Write-Host "JDK $($env:JAVA_HOME); SDK $($env:ANDROID_HOME); build-tools $($buildTools.Name)"

Write-Host '==> Copying web assets into the Android project'
& npx cap sync android
if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }

Write-Host '==> Building the release APK'
Push-Location (Join-Path $root 'android')
# 1.0.60 -> versionCode 10060: Android installs an update only over a lower code.
$ver = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$parts = $ver.Split('.') | ForEach-Object { [int]$_ }
$verCode = $parts[0] * 1000000 + $parts[1] * 10000 + $parts[2]
& .\gradlew.bat --no-daemon assembleRelease "-PnxVersionCode=$verCode" "-PnxVersionName=$ver"
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw 'gradle build failed' }

$unsigned = Join-Path $root 'android\app\build\outputs\apk\release\app-release-unsigned.apk'
$aligned = Join-Path $root 'android\app\build\outputs\apk\release\app-release-aligned.apk'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$outDir = Join-Path $root 'releases\updates'
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir "SaveState-$version.apk"

Write-Host '==> Signing'
& (Join-Path $buildTools.FullName 'zipalign.exe') -f -p 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }
& (Join-Path $buildTools.FullName 'apksigner.bat') sign --ks $keystore --ks-key-alias savestate --ks-pass "pass:$storePass" --key-pass "pass:$storePass" --out $out $aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner failed' }
& (Join-Path $buildTools.FullName 'apksigner.bat') verify $out
if ($LASTEXITCODE -ne 0) { throw 'signature verification failed' }
# Older builds would otherwise still be offered if their version sorts higher.
Get-ChildItem $outDir -File | Where-Object { $_.Name -match '\.apk(\.idsig)?$' -and $_.Name -notlike "$(Split-Path $out -Leaf)*" } | Remove-Item -Force
Write-Host "Published $out ($([math]::Round((Get-Item $out).Length / 1MB, 1)) MB)"
