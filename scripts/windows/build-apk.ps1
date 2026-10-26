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

# SaveState Engine for phones (Phase 7): the release library goes in the APK.
# Games play in the app on arm64 (SaveState's cores are arm64 builds); the
# 32-bit ARM and x86_64 builds are there so the APK installs on every phone,
# TV box and Chromebook: Android refuses an APK whose native code has no build
# for the device. Those keep using the emulator apps.
Write-Host '==> Building SaveState Engine for Android'
$strip = Join-Path $env:ANDROID_HOME 'ndk\27.3.13750724\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-strip.exe'
foreach ($a in @(@{ abi = 'arm64'; dir = 'arm64-v8a'; target = 'aarch64-linux-android' },
                 @{ abi = 'armv7'; dir = 'armeabi-v7a'; target = 'armv7-linux-androideabi' },
                 @{ abi = 'x86_64'; dir = 'x86_64'; target = 'x86_64-linux-android' })) {
  # cargo reports progress on stderr; cmd merges it so PowerShell doesn't take it for an error.
  $engineLog = & cmd /c "`"$(Join-Path $root 'engine\build-android.cmd')`" --release $($a.abi) 2>&1"
  if ($LASTEXITCODE -ne 0) { $engineLog | Select-Object -Last 30 | Write-Host; throw "engine build for Android ($($a.abi)) failed" }
  $jniDir = Join-Path $root "android\app\src\main\jniLibs\$($a.dir)"
  New-Item -ItemType Directory -Force $jniDir | Out-Null
  $so = Join-Path $jniDir 'libsavestate_engine.so'
  Copy-Item (Join-Path $root "engine\target\$($a.target)\release\libsavestate_engine.so") $so -Force
  & $strip --strip-unneeded $so
  Write-Host "    $($a.dir): libsavestate_engine.so $([math]::Round((Get-Item $so).Length / 1MB, 1)) MB"
}

Write-Host '==> Copying web assets into the Android project'
& npx cap sync android
if ($LASTEXITCODE -ne 0) { throw 'cap sync failed' }

Write-Host '==> Building the release APK'
Push-Location (Join-Path $root 'android')
# 1.0.60 -> versionCode 10060: Android installs an update only over a lower code.
$ver = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$parts = $ver.Split('.') | ForEach-Object { [int]$_ }
$verCode = $parts[0] * 1000000 + $parts[1] * 10000 + $parts[2]
# Notes javac prints on stderr aren't failures: cmd merges the streams (the exit code decides).
& cmd /c ".\gradlew.bat --no-daemon assembleRelease -PnxVersionCode=$verCode -PnxVersionName=$ver 2>&1"
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
