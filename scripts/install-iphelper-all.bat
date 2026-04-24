@echo off
setlocal enabledelayedexpansion

:: RouterFarm IP Helper — Mass Install Batch Wrapper
:: Runs the PowerShell installer. Right-click -> Run as administrator if needed.

cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install-iphelper-all.ps1" %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo Installation completed with errors. See output above.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo All done. Press any key to close.
pause >nul
