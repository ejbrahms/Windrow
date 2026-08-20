@echo off
REM One-click build: double-click this file (or run it from a terminal) to build the
REM client into client\dist. Run this after pulling changes or before packaging;
REM start.bat will also build automatically if client\dist is missing.
REM
REM The build carries no secret. The API authenticates callers with per-node mTLS client
REM certificates (docs/design/per-node-enrollment-credentials.md), so the bundle no longer
REM has a bearer token compiled into it and this build needs nothing configured to run.
cd /d "%~dp0"
npm run build
pause
