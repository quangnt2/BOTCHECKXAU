@echo off
setlocal
title BOTCHECKXAU Service
cd /d "%~dp0"

:: Cho mang on dinh 3 giay (khi vua khoi dong may)
ping 127.0.0.1 -n 4 >nul 2>&1

:: Kiem tra neu bot da chay thi khong khoi dong trung lap
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object CommandLine -like '*src*index.js*'; if ($p) { exit 1 } else { exit 0 }"
if %ERRORLEVEL% EQU 1 (
    echo [BOTCHECKXAU] Bot da dang chay trong he thong.
    exit /b 0
)

echo [BOTCHECKXAU] Khoi dong Bot XAU/USD da khung thoi gian...
node src/index.js
