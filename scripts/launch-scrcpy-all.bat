@echo off
setlocal enabledelayedexpansion

:: RouterFarm — Mass Launch scrcpy for All Devices
:: Launches scrcpy windows for every connected phone.
:: Keeps watching for newly authorized devices and auto-launches them.
:: Press Ctrl+C in the window to stop watching.

cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\launch-scrcpy-all.ps1" %*
