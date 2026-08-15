@echo off
REM Removes the Windrow Windows service installed by install-service.bat. Wraps
REM `npm run service:uninstall` (scripts/service-uninstall.js), which needs an elevated process
REM to talk to the Windows Service Control Manager — this file re-launches itself elevated (with
REM a UAC prompt) if it isn't already, so you can just double-click it.
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

call npm run service:uninstall
pause
