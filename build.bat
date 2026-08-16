@echo off
REM One-click build: double-click this file (or run it from a terminal) to build the
REM client into client\dist, baked with the server's bearer token. Run this after
REM pulling changes or before packaging; start.bat will also build automatically if
REM client\dist is missing.
cd /d "%~dp0"
npm run build
pause
