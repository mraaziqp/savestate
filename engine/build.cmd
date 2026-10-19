@echo off
rem Builds SaveState Engine with Rust's GNU toolchain (no Visual Studio needed).
rem Its bundled dlltool/ld live in the toolchain's self-contained folder, which
rem isn't on PATH by default; rustc needs dlltool for Windows system libraries.
rem   build.cmd            debug build
rem   build.cmd --release  release build
setlocal
for /f "delims=" %%S in ('rustup run stable-x86_64-pc-windows-gnu rustc --print sysroot') do set "SYSROOT=%%S"
set "PATH=%SYSROOT%\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained;%PATH%"
cd /d "%~dp0"
cargo build %*
