@echo off
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
