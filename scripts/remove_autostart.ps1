$startupFolder = [Environment]::GetFolderPath('Startup')
$targetFile = Join-Path $startupFolder "BOTCHECKXAU_AutoStart.vbs"

if (Test-Path $targetFile) {
    Remove-Item -Path $targetFile -Force
    Write-Host "[THANH CONG] Da xoa khoi muc Startup:" -ForegroundColor Green
    Write-Host "  $targetFile" -ForegroundColor Cyan
    Write-Host "Bot se khong con tu dong chay khi khoi dong Windows nua." -ForegroundColor Yellow
} else {
    Write-Host "[THONG BAO] Tap tin tu dong khoi dong khong ton tai hoac da duoc go bo truoc do." -ForegroundColor Yellow
}
