import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { path7za } from '7zip-bin';

const PROJECT_ROOT = process.cwd();
const STAGING_DIR = path.join(PROJECT_ROOT, 'dist', 'tauri-package');
const SOURCE_DIR = 'D:/NexusVerifyFinal';
const MAKENSIS = path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe');
const OUT_DIR = path.join(PROJECT_ROOT, 'releases', 'updates');

console.log('=== Building Native Tauri Windows Installer v1.0.75 ===');

// 1. Ensure staging directories
if (fs.existsSync(STAGING_DIR)) {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
}
fs.mkdirSync(STAGING_DIR, { recursive: true });
const appResources = path.join(STAGING_DIR, 'app-resources');
fs.mkdirSync(appResources, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// 2. Copy binaries from source
console.log('[1/5] Staging Tauri native executable and WebView2 loader...');
fs.copyFileSync(path.join(SOURCE_DIR, 'app.exe'), path.join(STAGING_DIR, 'SaveState.exe'));
fs.copyFileSync(path.join(SOURCE_DIR, 'WebView2Loader.dll'), path.join(STAGING_DIR, 'WebView2Loader.dll'));

// 3. Stage app-resources
console.log('[2/5] Staging app-resources (client launcher, embedded node runtime, dist, public, gamepad bridge)...');

// a) client-launcher.cjs (with fixed Dolphin controller config)
fs.copyFileSync(path.join(PROJECT_ROOT, 'client-launcher.cjs'), path.join(appResources, 'client-launcher.cjs'));

// b) node-win-x64
const nodeWinDir = path.join(appResources, 'node-win-x64');
fs.mkdirSync(nodeWinDir, { recursive: true });
fs.copyFileSync(path.join(SOURCE_DIR, 'app-resources', 'node-win-x64', 'node.exe'), path.join(nodeWinDir, 'node.exe'));

// c) windows-gamepad-bridge
const bridgePubDir = path.join(appResources, 'windows-gamepad-bridge', 'publish');
fs.mkdirSync(bridgePubDir, { recursive: true });
const bridgeSrc = path.join(SOURCE_DIR, 'app-resources', 'windows-gamepad-bridge', 'publish');
if (fs.existsSync(bridgeSrc)) {
  for (const f of fs.readdirSync(bridgeSrc)) {
    fs.copyFileSync(path.join(bridgeSrc, f), path.join(bridgePubDir, f));
  }
}

// d) package.json
fs.copyFileSync(path.join(PROJECT_ROOT, 'package.json'), path.join(appResources, 'package.json'));

// e) public
const publicDest = path.join(appResources, 'public');
fs.mkdirSync(publicDest, { recursive: true });
for (const f of fs.readdirSync(path.join(PROJECT_ROOT, 'public'))) {
  const p = path.join(PROJECT_ROOT, 'public', f);
  if (fs.statSync(p).isFile()) {
    fs.copyFileSync(p, path.join(publicDest, f));
  }
}

// f) dist (frontend assets only, skip windows-host or huge dumps)
const distDest = path.join(appResources, 'dist');
fs.mkdirSync(distDest, { recursive: true });
const distSrc = path.join(PROJECT_ROOT, 'dist');
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    if (item.name === 'windows-host' || item.name === 'tauri-package' || item.name.endsWith('.tar.gz')) continue;
    const srcPath = path.join(src, item.name);
    const destPath = path.join(dest, item.name);
    if (item.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
copyDirRecursive(distSrc, distDest);

console.log('[3/5] Staging complete. Generating NSIS script...');

const icoPath = path.join(PROJECT_ROOT, 'public', 'favicon.ico').replace(/\\/g, '\\\\');
const stagingNsis = STAGING_DIR.replace(/\\/g, '\\\\');
const outInstaller = path.join(OUT_DIR, 'SaveState-Setup-1.0.75.exe').replace(/\\/g, '\\\\');

const nsiScript = `
Unicode true
ManifestDPIAwareness PerMonitorV2
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

!define PRODUCT_NAME "SaveState"
!define PRODUCT_VERSION "1.0.75"
!define PRODUCT_PUBLISHER "SaveState"
!define PRODUCT_WEB_SITE "https://savestate.co.za"
!define PRODUCT_DIR_REGKEY "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\SaveState.exe"
!define PRODUCT_UNINST_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SaveState"

SetCompressor /SOLID lzma

Name "\${PRODUCT_NAME} \${PRODUCT_VERSION}"
OutFile "${outInstaller}"
InstallDir "$LOCALAPPDATA\\Programs\\SaveState"
InstallDirRegKey HKCU "\${PRODUCT_DIR_REGKEY}" ""

!define MUI_ICON "${icoPath}"
!define MUI_UNICON "${icoPath}"
!define MUI_ABORTWARNING

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\\SaveState.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start SaveState now"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  SetOverwrite on

  ; Stop any running launcher on upgrade
  nsExec::Exec 'taskkill /F /IM SaveState.exe /T'
  
  File "${stagingNsis}\\SaveState.exe"
  File "${stagingNsis}\\WebView2Loader.dll"

  SetOutPath "$INSTDIR\\app-resources"
  File /r "${stagingNsis}\\app-resources\\*.*"

  ; Shortcuts
  CreateDirectory "$SMPROGRAMS\\SaveState"
  CreateShortcut "$SMPROGRAMS\\SaveState\\SaveState.lnk" "$INSTDIR\\SaveState.exe" "" "${icoPath}" 0
  CreateShortcut "$DESKTOP\\SaveState.lnk" "$INSTDIR\\SaveState.exe" "" "${icoPath}" 0

  ; Protocol Handlers
  WriteRegStr HKCU "Software\\Classes\\savestate" "" "URL:SaveState Protocol"
  WriteRegStr HKCU "Software\\Classes\\savestate" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\savestate\\DefaultIcon" "" "$INSTDIR\\SaveState.exe,0"
  WriteRegStr HKCU "Software\\Classes\\savestate\\shell\\open\\command" "" '"$INSTDIR\\SaveState.exe" "%1"'

  WriteRegStr HKCU "Software\\Classes\\nexusemu" "" "URL:SaveState Nexus Protocol"
  WriteRegStr HKCU "Software\\Classes\\nexusemu" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\nexusemu\\DefaultIcon" "" "$INSTDIR\\SaveState.exe,0"
  WriteRegStr HKCU "Software\\Classes\\nexusemu\\shell\\open\\command" "" '"$INSTDIR\\SaveState.exe" "%1"'

  ; Write Uninstaller
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\\SaveState\\Uninstall SaveState.lnk" "$INSTDIR\\uninstall.exe"

  ; Registry info for Windows Settings / Apps
  WriteRegStr HKCU "\${PRODUCT_DIR_REGKEY}" "" "$INSTDIR\\SaveState.exe"
  WriteRegStr HKCU "\${PRODUCT_UNINST_KEY}" "DisplayName" "\${PRODUCT_NAME}"
  WriteRegStr HKCU "\${PRODUCT_UNINST_KEY}" "UninstallString" '"$INSTDIR\\uninstall.exe"'
  WriteRegStr HKCU "\${PRODUCT_UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\\uninstall.exe" /S'
  WriteRegStr HKCU "\${PRODUCT_UNINST_KEY}" "DisplayIcon" "$INSTDIR\\SaveState.exe,0"
  WriteRegStr HKCU "\${PRODUCT_UNINST_KEY}" "DisplayVersion" "\${PRODUCT_VERSION}"
  WriteRegStr HKCU "\${PRODUCT_UNINST_KEY}" "Publisher" "\${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "\${PRODUCT_UNINST_KEY}" "URLInfoAbout" "\${PRODUCT_WEB_SITE}"
  WriteRegStr HKCU "\${PRODUCT_UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "\${PRODUCT_UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "\${PRODUCT_UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM SaveState.exe /T'

  RMDir /r "$INSTDIR\\app-resources"
  Delete "$INSTDIR\\SaveState.exe"
  Delete "$INSTDIR\\WebView2Loader.dll"
  Delete "$INSTDIR\\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\\SaveState\\SaveState.lnk"
  Delete "$SMPROGRAMS\\SaveState\\Uninstall SaveState.lnk"
  RMDir "$SMPROGRAMS\\SaveState"
  Delete "$DESKTOP\\SaveState.lnk"

  DeleteRegKey HKCU "Software\\Classes\\savestate"
  DeleteRegKey HKCU "Software\\Classes\\nexusemu"
  DeleteRegKey HKCU "\${PRODUCT_DIR_REGKEY}"
  DeleteRegKey HKCU "\${PRODUCT_UNINST_KEY}"
SectionEnd
`;

const nsiPath = path.join(STAGING_DIR, 'installer.nsi');
fs.writeFileSync(nsiPath, nsiScript, 'utf8');

// 4. Compile NSIS installer
console.log('[4/5] Compiling NSIS installer via makensis.exe...');
const makensisOut = execFileSync(MAKENSIS, [nsiPath], { encoding: 'utf8' });
console.log(makensisOut.split('\n').filter(l => l.includes('Output:') || l.includes('Install:') || l.includes('Total size:')).join('\n'));

// 5. Build clean Portable ZIP package
console.log('[5/5] Building clean portable ZIP package (SaveState-Windows-Portable-1.0.75.zip)...');
const zipOut = path.join(OUT_DIR, 'SaveState-Windows-Portable-1.0.75.zip');
if (fs.existsSync(zipOut)) fs.unlinkSync(zipOut);

execSync(`"${path7za}" a -tzip "${zipOut}" "${STAGING_DIR}\\*" -mx=7 -xr!installer.nsi`, { encoding: 'utf8' });

const installerStat = fs.statSync(path.join(OUT_DIR, 'SaveState-Setup-1.0.75.exe'));
const zipStat = fs.statSync(zipOut);

console.log('=== BUILD SUCCESSFUL ===');
console.log(`NSIS Tauri Installer: ${path.join(OUT_DIR, 'SaveState-Setup-1.0.75.exe')} (${(installerStat.size / 1024 / 1024).toFixed(2)} MB)`);
console.log(`Portable ZIP Package: ${zipOut} (${(zipStat.size / 1024 / 1024).toFixed(2)} MB)`);
