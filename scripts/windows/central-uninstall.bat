@echo off
REM Removes the WindrowCentral Windows service installed by central-install.bat. Wraps
REM `npm run central:uninstall` (scripts/central-install.js --uninstall), which needs an elevated
REM process to talk to the Windows Service Control Manager -- this file re-launches itself elevated
REM (with a UAC prompt) if it isn't already, so you can just double-click it.
REM
REM uninstall-service.bat is the wrong script for this: it removes the NODE service, named Windrow,
REM and would not find this one. Removing the service leaves the Postgres database untouched.
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

call npm run central:uninstall
pause
