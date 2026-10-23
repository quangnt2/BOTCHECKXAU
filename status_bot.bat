@echo off
setlocal
cd /d "%~dp0"
echo ========================================================
echo         TRANG THAI TIEN TRINH BOTCHECKXAU
echo ========================================================
powershell -NoProfile -ExecutionPolicy Bypass -Command "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object CommandLine -like '*src*index.js*'; if ($procs) { Write-Host 'Trang thai: DANG CHAY (RUNNING)' -ForegroundColor Green; foreach ($p in $procs) { Write-Host (' - PID: ' + $p.ProcessId + ' | Khoi tao luc: ' + (Get-Process -Id $p.ProcessId).StartTime) -ForegroundColor Cyan } } else { Write-Host 'Trang thai: DA DUNG (STOPPED)' -ForegroundColor Red }"
echo.
echo --- 10 DONG LOG GAN NHAT ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "$latest = Get-ChildItem logs -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($latest) { Write-Host ('[Nguon: ' + $latest.Name + ']') -ForegroundColor Yellow; Get-Content $latest.FullName -Tail 10 } else { Write-Host 'Chua tim thay file log nao trong logs/' }"
echo ========================================================
pause
