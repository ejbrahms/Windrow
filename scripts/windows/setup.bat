@echo off
REM One-click setup: double-click this file (or run it from a terminal) to configure this
REM machine. Asks what it is -- a node on its own, a node joining a fleet, the central host,
REM or both for development -- and runs the right steps for the answer. Every step is
REM idempotent, so you can run it as often as you like.
REM
REM It writes windrow.env at the repo root, which server/config.js reads at startup, so the
REM configuration outlives this window. Run `npm run setup -- --show` to read it back.
REM
REM DELIBERATELY NOT ELEVATED, unlike install-service.bat. The wizard writes windrow.env and
REM builds the client, and doing that as Administrator leaves files the ordinary user then has
REM to fight. Only the optional last step -- registering a Windows service -- needs admin, so
REM the wizard detects an unelevated shell, skips that question rather than asking one whose
REM only outcome is a failure, and prints the single command to run afterwards from an elevated
REM terminal (or just double-click install-service.bat / central-install.bat, which elevate
REM themselves).
cd /d "%~dp0"
node scripts\setup.js %*
pause
