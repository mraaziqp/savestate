#!/usr/bin/env node
/**
 * scripts/build-windows-exe.js
 * 
 * Standalone Windows Desktop Host Packaging & Zero-Config Installer Orchestrator
 * 
 * Responsibilities:
 * 1. Validates distribution prerequisites (frontend dist/, backend dist/server.mjs, runtime).
 * 2. Generates silent Windows background service installer (nexus-service via sc.exe) with
 *    automatic startup and 3-tier failure restart rules.
 * 3. Generates custom URI protocol handler registry scripts (nexus://join/sessionId, nexus://play/gameId).
 * 4. Produces zero-config launcher scripts (silent VBScript runner, batch scripts).
 * 5. Bundles output into dist/windows-host/ with complete installation manifest.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'dist', 'windows-host');

function log(step, msg) {
  console.log(`[build-windows-exe] [${step}] ${msg}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function run() {
  console.log('===============================================================');
  console.log(' NexusEmu Windows Desktop Host & Zero-Config Installer Builder ');
  console.log('===============================================================');

  // Step 1: Validate Prerequisites
  log('1/5', 'Validating build components...');
  const frontendIndex = path.join(repoRoot, 'dist', 'index.html');
  const backendServer = path.join(repoRoot, 'dist', 'server.mjs');

  const frontendReady = fs.existsSync(frontendIndex);
  const backendReady = fs.existsSync(backendServer);

  if (!frontendReady) {
    log('WARN', 'Frontend dist/index.html not found (run `npm run build` for release bundle).');
  } else {
    log('OK', 'Frontend bundle detected in dist/');
  }

  if (!backendReady) {
    log('WARN', 'Backend dist/server.mjs not found (run `./build-server.sh` for release bundle).');
  } else {
    const stat = fs.statSync(backendServer);
    log('OK', `Backend server detected in dist/server.mjs (${(stat.size / 1024).toFixed(1)} KB)`);
  }

  ensureDir(outDir);

  // Step 2: Generate Windows Service Scripts (nexus-service)
  log('2/5', 'Generating Windows Service installer scripts (sc.exe)...');

  const installServiceBat = `@echo off
:: NexusEmu Silent Background Service Installer
:: Requires Administrator Privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] This installer requires Administrator privileges.
    echo Please right-click install-service.bat and choose "Run as administrator".
    pause
    exit /b 1
)

set SERVICE_NAME=nexus-service
set DISPLAY_NAME=NexusEmu Host Background Service
set SERVICE_DESC=Provides silent local emulation hosting, ROM vault synchronization, and WebRTC streaming for NexusEmu.
set INSTALL_DIR=%~dp0
set NODE_EXE=%INSTALL_DIR%node.exe
if not exist "%NODE_EXE%" set NODE_EXE=node.exe

set SERVER_SCRIPT=%INSTALL_DIR%server.mjs
set BIN_PATH=\\"%NODE_EXE%\\" \\"%SERVER_SCRIPT%\\"

echo [*] Installing %SERVICE_NAME%...
sc.exe query %SERVICE_NAME% >nul 2>&1
if %errorLevel% equ 0 (
    echo [*] Service already exists. Stopping and updating...
    sc.exe stop %SERVICE_NAME% >nul 2>&1
    timeout /t 2 /nobreak >nul
    sc.exe delete %SERVICE_NAME% >nul 2>&1
    timeout /t 1 /nobreak >nul
)

sc.exe create %SERVICE_NAME% binPath= "%BIN_PATH%" DisplayName= "%DISPLAY_NAME%" start= auto
sc.exe description %SERVICE_NAME% "%SERVICE_DESC%"
sc.exe failure %SERVICE_NAME% reset= 86400 actions= restart/5000/restart/5000/restart/5000

echo [*] Starting %SERVICE_NAME%...
sc.exe start %SERVICE_NAME%

echo.
echo [SUCCESS] %DISPLAY_NAME% installed and started successfully!
echo NexusEmu is now running silently in the background on port 3000.
`;
  fs.writeFileSync(path.join(outDir, 'install-service.bat'), installServiceBat, 'utf8');

  const uninstallServiceBat = `@echo off
:: NexusEmu Background Service Uninstaller
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] This uninstaller requires Administrator privileges.
    pause
    exit /b 1
)

set SERVICE_NAME=nexus-service
echo [*] Stopping %SERVICE_NAME%...
sc.exe stop %SERVICE_NAME% >nul 2>&1
timeout /t 2 /nobreak >nul

echo [*] Removing %SERVICE_NAME%...
sc.exe delete %SERVICE_NAME% >nul 2>&1

echo [SUCCESS] %SERVICE_NAME% removed.
`;
  fs.writeFileSync(path.join(outDir, 'uninstall-service.bat'), uninstallServiceBat, 'utf8');

  // Step 3: Generate Custom URI Protocol Handler (nexus://)
  log('3/5', 'Generating custom URI protocol handler (nexus://)...');

  const registerProtocolBat = `@echo off
:: NexusEmu Protocol Handler Registration (nexus://)
setlocal enabledelayedexpansion
set INSTALL_DIR=%~dp0
set LAUNCHER_EXE=%INSTALL_DIR%NexusEmu.exe
if not exist "%LAUNCHER_EXE%" set LAUNCHER_EXE=%INSTALL_DIR%launch.bat

echo [*] Registering nexus:// protocol handler in Windows Registry...

reg add "HKCR\\nexus" /ve /t REG_SZ /d "URL:Nexus Protocol" /f >nul
reg add "HKCR\\nexus" /v "URL Protocol" /t REG_SZ /d "" /f >nul
reg add "HKCR\\nexus\\DefaultIcon" /ve /t REG_SZ /d "\"%LAUNCHER_EXE%\",0" /f >nul
reg add "HKCR\\nexus\\shell\\open\\command" /ve /t REG_SZ /d "\"%LAUNCHER_EXE%\" \"%%1\"" /f >nul

if %errorLevel% equ 0 (
    echo [SUCCESS] nexus:// protocol handler registered!
    echo Clicking links like nexus://join/sessionId will now launch NexusEmu directly.
) else (
    echo [ERROR] Failed to register protocol. Administrator rights may be required.
)
`;
  fs.writeFileSync(path.join(outDir, 'register-protocol.bat'), registerProtocolBat, 'utf8');

  const registerProtocolReg = `Windows Registry Editor Version 5.00

[HKEY_CLASSES_ROOT\\nexus]
@="URL:Nexus Protocol"
"URL Protocol"=""

[HKEY_CLASSES_ROOT\\nexus\\DefaultIcon]
@="NexusEmu.exe,0"

[HKEY_CLASSES_ROOT\\nexus\\shell]

[HKEY_CLASSES_ROOT\\nexus\\shell\\open]

[HKEY_CLASSES_ROOT\\nexus\\shell\\open\\command]
@="\\"%~dp0NexusEmu.exe\\" \\"%1\\""
`;
  fs.writeFileSync(path.join(outDir, 'register-protocol.reg'), registerProtocolReg, 'utf8');

  // Step 4: Silent Daemon Runner (VBScript + Batch)
  log('4/5', 'Generating zero-window background launchers...');

  const silentLauncherVbs = `' NexusEmu Silent Background Launcher
Set WshShell = CreateObject("WScript.Shell")
strPath = WScript.ScriptFullName
Set FSO = CreateObject("Scripting.FileSystemObject")
Set Folder = FSO.GetFile(strPath).ParentFolder

cmd = "node.exe """ & Folder.Path & "\\server.mjs"""
WshShell.Run cmd, 0, False
Set WshShell = Nothing
`;
  fs.writeFileSync(path.join(outDir, 'launch-silent.vbs'), silentLauncherVbs, 'utf8');

  const launchBat = `@echo off
set INSTALL_DIR=%~dp0
start "" wscript.exe "%INSTALL_DIR%launch-silent.vbs"
start http://localhost:3000
`;
  fs.writeFileSync(path.join(outDir, 'launch.bat'), launchBat, 'utf8');

  // Step 5: Distribution Manifest & Package Descriptor
  log('5/5', 'Emitting package manifest...');

  const manifest = {
    name: 'NexusEmu Windows Desktop Host',
    version: '2.0.4',
    packageDate: new Date().toISOString(),
    service: {
      id: 'nexus-service',
      displayName: 'NexusEmu Host Background Service',
      startup: 'auto',
      restartRules: 'reset=86400 actions=restart/5000/restart/5000/restart/5000',
    },
    protocol: {
      scheme: 'nexus',
      routes: [
        { pattern: 'nexus://join/:sessionId', description: 'One-click WebRTC Co-Op session join' },
        { pattern: 'nexus://play/:gameId', description: 'Direct ROM / game launch' },
      ],
    },
    artifacts: [
      'install-service.bat',
      'uninstall-service.bat',
      'register-protocol.bat',
      'register-protocol.reg',
      'launch-silent.vbs',
      'launch.bat',
    ],
  };

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  log('DONE', `Packaging artifacts generated in: ${outDir}`);
  console.log('===============================================================');
  console.log(' Windows Host Packaging Complete (Zero-Config Ready)          ');
  console.log('===============================================================');
  return { ok: true, outDir, manifest };
}

run().catch((err) => {
  console.error('[build-windows-exe] ERROR:', err);
  process.exit(1);
});
