@echo off
setlocal
title BOTCHECKXAU Service Watchdog
cd /d "%~dp0"

:: Cho mang on dinh 3 giay (khi vua khoi dong may)
ping 127.0.0.1 -n 4 >nul 2>&1

:: Kiem tra neu bot da dang chay thi khong khoi dong trung lap
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object CommandLine -like '*src*index.js*'; if ($p) { exit 1 } else { exit 0 }"
if %ERRORLEVEL% EQU 1 (
    echo [BOTCHECKXAU] Bot da dang chay trong he thong.
    exit /b 0
)

:loop
echo ========================================================
echo [BOTCHECKXAU] Khoi dong Bot XAU/USD da khung thoi gian...
echo ========================================================
node src/index.js
set EXIT_CODE=%ERRORLEVEL%
echo.
echo [CANH BAO] Bot bi dung hoac crash (Exit Code: %EXIT_CODE%).
echo [WATCHDOG] Tu dong khoi dong lai bot sau 5 giay...
echo.
timeout /t 5 >nul
goto loop
