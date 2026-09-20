@echo off
set INSTALL_DIR=%~dp0
start "" wscript.exe "%INSTALL_DIR%launch-silent.vbs"
start http://localhost:3000
