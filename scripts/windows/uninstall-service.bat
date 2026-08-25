@echo off
REM Removes the Windrow NODE service installed by install-service.bat. Wraps
REM `npm run service:uninstall` (scripts/service-uninstall.js), which needs an elevated process
REM to talk to the Windows Service Control Manager -- this file re-launches itself elevated (with
REM a UAC prompt) if it isn't already, so you can just double-click it.
REM
REM This removes the service named Windrow only. The CENTRAL host's service is named
REM WindrowCentral and is removed by central-uninstall.bat; on a single-box fleet both are
REM installed and this file leaves the other one running.
REM
REM Nothing in server/data is touched: the node's SQLite registry and its enrollment credential
REM survive, so re-running install-service.bat brings the same node back rather than a new one.
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

call npm run service:uninstall
pause
