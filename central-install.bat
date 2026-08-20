@echo off
REM Installs the CENTRAL host as a Windows service (service name: WindrowCentral), so central
REM survives a reboot instead of running in a terminal someone leaves open. Wraps
REM `npm run central:install` (scripts/central-install.js), which needs an elevated process to talk
REM to the Windows Service Control Manager -- this file re-launches itself elevated (with a UAC
REM prompt) if it isn't already, so you can just double-click it.
REM
REM This is the CENTRAL counterpart of install-service.bat, and the two are deliberately separate:
REM they register different entry points under different service names, and a node that ran the
REM wrong one would get a service that starts and does nothing. Both may legitimately be installed
REM on one machine (a single-box fleet).
REM
REM   install-service.bat   Windrow          server/supervisor.js       a user's PC
REM   central-install.bat   WindrowCentral   server/central/index.js    the central host
REM
REM No `npm run build` here, unlike install-service.bat: central serves the fleet API, not the
REM dashboard, so there is no client bundle for it to be stale.
REM
REM WINDROW_CENTRAL_DB_URL MUST BE SET, and it should be set in windrow.env rather than in this
REM terminal. The installer refuses to register a service without a database (a central with no DSN
REM would start, throw inside store.open(), and become an SCM restart loop with the reason buried in
REM a log file) and waits for Postgres to answer before starting the service. The UAC re-launch
REM below starts a FRESH elevated process, which does not carry variables set in the calling
REM terminal -- windrow.env survives that hop and a shell variable does not. `npm run setup` writes
REM it.
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    echo NOTE: the elevated process starts with a fresh environment. WINDROW_CENTRAL_DB_URL set in
    echo       this terminal will NOT reach the installer -- put it in windrow.env instead.
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

call npm run central:install
pause
