@echo off
rem Double-click: adds "SaveState" to Sunshine so Moonlight can open Big Picture
rem on this PC and play any game in the library. Windows asks for permission once.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0add-sunshine-app.ps1"
