@echo off
REM Installs this machine's Windrow NODE as a Windows service (service name: Windrow), so it starts
REM on boot and restarts on crash instead of only running in a terminal someone leaves open.
REM Rebuilds the client first (`npm run build`) so the service serves the latest frontend, then
REM wraps `npm run service:install` (scripts/service-install.js), which needs an elevated process to
REM talk to the Windows Service Control Manager -- this file re-launches itself elevated (with a UAC
REM prompt) if it isn't already, so you can just double-click it.
REM
REM For the CENTRAL host, this is the wrong script: use central-install.bat, which registers
REM server/central/index.js as the separate WindrowCentral service.
REM
REM PUT THE FLEET CONFIGURATION IN windrow.env, NOT IN YOUR SHELL.
REM   service-install.js snapshots WINDROW_CENTRAL_URL, WINDROW_POLICY_AUTHORITY and the rest of
REM   this node's configuration and hands it to the service explicitly, because a service inherits
REM   the SYSTEM environment rather than the installing shell's. The UAC re-launch below starts a
REM   FRESH elevated process, which does not carry variables you set in the terminal that ran this
REM   file -- so anything configured that way is already gone by the time the snapshot is taken.
REM   windrow.env survives the hop (service-install.js loads it via server/config.js), and
REM   `npm run setup` writes it. The installer prints what it captured AND what it omitted: read
REM   that list. A node configured for a fleet but installed without those variables comes back up
REM   standalone, ships nothing, pulls no policy, and reports itself perfectly healthy.
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    echo NOTE: the elevated process starts with a fresh environment. Fleet configuration set in
    echo       this terminal will NOT reach the service -- put it in windrow.env instead.
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

call npm run build
call npm run service:install
pause
