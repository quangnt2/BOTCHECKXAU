@echo off
setlocal
cd /d "%~dp0"
echo [BOTCHECKXAU] Dang tim va dung tien trinh Bot XAU/USD...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object CommandLine -like '*src*index.js*'; if ($procs) { foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force; Write-Host ('[BOTCHECKXAU] Da dung tien trinh PID: ' + $p.ProcessId) -ForegroundColor Green } } else { Write-Host '[BOTCHECKXAU] Khong co tien trinh bot nao dang chay.' -ForegroundColor Yellow }"
echo [BOTCHECKXAU] Hoan tat.
ping 127.0.0.1 -n 3 >nul 2>&1
