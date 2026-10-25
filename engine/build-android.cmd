@echo off
rem Builds SaveState Engine's library for Android phones and tablets (arm64)
rem as libsavestate_engine.so (Phase 7, SAVESTATE_ENGINE_SPEC.md 14).
rem Needs the Android NDK (sdkmanager "ndk;27.3.13750724") and Rust's target
rem (rustup target add aarch64-linux-android --toolchain stable-x86_64-pc-windows-gnu).
rem   build-android.cmd            debug build
rem   build-android.cmd --release  release build
rem The library lands in target\aarch64-linux-android\<debug|release>\.
setlocal
if "%ANDROID_HOME%"=="" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "NDK=%ANDROID_HOME%\ndk\27.3.13750724"
if not exist "%NDK%" (echo Android NDK 27.3.13750724 not found under %ANDROID_HOME%\ndk & exit /b 1)
set "LLVM=%NDK%\toolchains\llvm\prebuilt\windows-x86_64\bin"
rem Android 8.0 (API 26): the oldest with AAudio, which the engine's sound uses.
set "CC_aarch64_linux_android=%LLVM%\aarch64-linux-android26-clang.cmd"
set "AR_aarch64_linux_android=%LLVM%\llvm-ar.exe"
set "CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=%LLVM%\aarch64-linux-android26-clang.cmd"
cd /d "%~dp0engine"
rustup run stable-x86_64-pc-windows-gnu cargo rustc --lib --target aarch64-linux-android --crate-type cdylib %*
