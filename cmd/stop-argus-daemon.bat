@echo off
rem Stop the running Argus daemon (reads its pid from the discovery file).
cd /d "%~dp0.."
node scripts\daemon-stop.js
