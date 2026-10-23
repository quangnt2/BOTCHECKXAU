@echo off
setlocal
cd /d "%~dp0"
echo ========================================================
echo   CAI DAT TU DONG KHOI DONG BOTCHECKXAU CUNG WINDOWS
echo ========================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_autostart.ps1"
echo.
pause
