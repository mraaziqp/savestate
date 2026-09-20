@echo off
:: NexusEmu Protocol Handler Registration (nexus://)
setlocal enabledelayedexpansion
set INSTALL_DIR=%~dp0
set LAUNCHER_EXE=%INSTALL_DIR%NexusEmu.exe
if not exist "%LAUNCHER_EXE%" set LAUNCHER_EXE=%INSTALL_DIR%launch.bat

echo [*] Registering nexus:// protocol handler in Windows Registry...

reg add "HKCR\nexus" /ve /t REG_SZ /d "URL:Nexus Protocol" /f >nul
reg add "HKCR\nexus" /v "URL Protocol" /t REG_SZ /d "" /f >nul
reg add "HKCR\nexus\DefaultIcon" /ve /t REG_SZ /d ""%LAUNCHER_EXE%",0" /f >nul
reg add "HKCR\nexus\shell\open\command" /ve /t REG_SZ /d ""%LAUNCHER_EXE%" "%%1"" /f >nul

if %errorLevel% equ 0 (
    echo [SUCCESS] nexus:// protocol handler registered!
    echo Clicking links like nexus://join/sessionId will now launch NexusEmu directly.
) else (
    echo [ERROR] Failed to register protocol. Administrator rights may be required.
)
