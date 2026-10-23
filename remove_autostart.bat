@echo off
setlocal
cd /d "%~dp0"
echo ========================================================
echo   HUY CAI DAT TU DONG KHOI DONG BOTCHECKXAU CUNG WINDOWS
echo ========================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remove_autostart.ps1"
echo.
pause
