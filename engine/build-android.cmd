@echo off
rem Builds SaveState Engine's library for Android as libsavestate_engine.so
rem (Phase 7, SAVESTATE_ENGINE_SPEC.md 14).
rem Needs the Android NDK (sdkmanager "ndk;27.3.13750724") and Rust's targets
rem (rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
rem  --toolchain stable-x86_64-pc-windows-gnu).
rem   build-android.cmd [--release] [arm64|armv7|x86_64]   (default arm64)
rem The library lands in target\<rust target>\<debug|release>\. Games play in
rem the app on arm64 (our cores are arm64); the other two are built so the APK
rem installs on every phone, TV box and Chromebook (Android refuses an APK
rem whose native code has no build for the device).
setlocal
set "HERE=%~dp0"
set "PROFILE="
set "ABI=arm64"
:args
if "%~1"=="" goto done
if /i "%~1"=="--release" (set "PROFILE=--release") else (set "ABI=%~1")
shift
goto args
:done
if /i "%ABI%"=="arm64" (set "TARGET=aarch64-linux-android" & set "CLANG=aarch64-linux-android26-clang.cmd" & set "TVAR=AARCH64_LINUX_ANDROID" & set "CVAR=aarch64_linux_android")
if /i "%ABI%"=="armv7" (set "TARGET=armv7-linux-androideabi" & set "CLANG=armv7a-linux-androideabi26-clang.cmd" & set "TVAR=ARMV7_LINUX_ANDROIDEABI" & set "CVAR=armv7_linux_androideabi")
if /i "%ABI%"=="x86_64" (set "TARGET=x86_64-linux-android" & set "CLANG=x86_64-linux-android26-clang.cmd" & set "TVAR=X86_64_LINUX_ANDROID" & set "CVAR=x86_64_linux_android")
if "%TARGET%"=="" (echo Unknown ABI %ABI%: use arm64, armv7 or x86_64 & exit /b 1)
if "%ANDROID_HOME%"=="" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "NDK=%ANDROID_HOME%\ndk\27.3.13750724"
if not exist "%NDK%" (echo Android NDK 27.3.13750724 not found under %ANDROID_HOME%\ndk & exit /b 1)
set "LLVM=%NDK%\toolchains\llvm\prebuilt\windows-x86_64\bin"
rem Android 8.0 (API 26): the oldest with AAudio, which the engine's sound uses.
set "CC_%CVAR%=%LLVM%\%CLANG%"
set "AR_%CVAR%=%LLVM%\llvm-ar.exe"
set "CARGO_TARGET_%TVAR%_LINKER=%LLVM%\%CLANG%"
cd /d "%HERE%engine"
rustup run stable-x86_64-pc-windows-gnu cargo rustc --lib --target %TARGET% --crate-type cdylib %PROFILE%
