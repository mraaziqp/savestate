@echo off
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
set BIN_PATH=\"%NODE_EXE%\" \"%SERVER_SCRIPT%\"

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
