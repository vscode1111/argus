@echo off
setlocal
cd /d "%~dp0.."

echo === Pulling latest changes from main ===
git checkout main || goto :error
git pull --ff-only origin main || goto :error

echo.
echo === Installing dependencies ===
call yarn install || goto :error

echo.
echo === Building and installing the extension ===
call yarn ext:install || goto :error

echo.
echo === Installed Argus version ===
call code.cmd --list-extensions --show-versions | %SystemRoot%\System32\find.exe /i "local.argus"

echo.
echo === Restart VS Code to activate the new version ===
echo Do NOT run this from inside VS Code's integrated terminal.
tasklist /fi "imagename eq Code.exe" 2>nul | %SystemRoot%\System32\find.exe /i "Code.exe" >nul
if errorlevel 1 (
    echo VS Code is not running - the new version will load on next launch.
    goto :done
)

echo Closing all VS Code windows and restarting...
taskkill /f /im Code.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start "" code.cmd
echo VS Code restarted (previous windows restored if window.restoreWindows is "all").

:done
echo.
echo Done.
pause
exit /b 0

:error
echo.
echo Failed with error %errorlevel%.
pause
exit /b %errorlevel%
