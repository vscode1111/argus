@echo off
tasklist /fi "imagename eq claude.exe" 2>nul | %SystemRoot%\System32\find.exe /i "claude.exe" >nul
if %errorlevel%==0 (
    echo Terminating all Claude Code instances...
    taskkill /f /im claude.exe
) else (
    echo No Claude Code instances found.
)
pause
