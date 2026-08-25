@echo off
REM One-click startup: double-click this file (or run it from a terminal) to launch
REM windrow. Builds the client if needed and starts the combined server on
REM http://localhost:4000. If it's already running, you'll be asked whether to kill
REM and restart it. Close this window to stop the server.
cd /d "%~dp0"
node scripts\start.js
pause
