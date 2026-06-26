@echo off
rem Start the Argus daemon windowless and detached, so closing this console does
rem not kill it. The daemon self-exits ~10 minutes after the last Argus panel
rem closes. Requires a compiled build (run `yarn compile` once); the launcher runs
rem the compiled out\backend\daemon.js.
cd /d "%~dp0.."
if not exist "out\backend\daemon.js" (
  echo [argus] out\backend\daemon.js not found. Run "yarn compile" first.
  pause
  exit /b 1
)
wscript.exe "%~dp0..\scripts\daemon.vbs"
echo [argus] daemon launch requested (windowless). It self-exits when idle.
