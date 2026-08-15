@echo off
REM Installs windrow as a Windows service (Windrow), so it starts on boot and
REM restarts on crash instead of only running in a terminal someone leaves open. Rebuilds the
REM client first (`npm run build`) so the service serves the latest frontend, then wraps
REM `npm run service:install` (scripts/service-install.js), which needs an elevated process to
REM talk to the Windows Service Control Manager — this file re-launches itself elevated (with a
REM UAC prompt) if it isn't already, so you can just double-click it.
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

call npm run build
call npm run service:install
pause
