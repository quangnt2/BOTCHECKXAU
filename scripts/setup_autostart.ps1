$startupFolder = [Environment]::GetFolderPath('Startup')
$targetFile = Join-Path $startupFolder "BOTCHECKXAU_AutoStart.vbs"
$projectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$startSilentScript = Join-Path $projectDir "start_silent.vbs"

$vbsContent = @"
' Tu dong khoi dong ngam BOTCHECKXAU cung Windows
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "$projectDir"
WshShell.Run "wscript.exe " & Chr(34) & "$startSilentScript" & Chr(34), 0, False
"@

try {
    [System.IO.File]::WriteAllText($targetFile, $vbsContent, [System.Text.Encoding]::ASCII)
    Write-Host "[THANH CONG] Da tao tap tin khoi dong ngam tai:" -ForegroundColor Green
    Write-Host "  $targetFile" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Moi khi bat may tinh va dang nhap vao Windows, Bot XAU/USD se tu dong chay ngam (khong hien man hinh den)!" -ForegroundColor Green
} catch {
    Write-Host ("[THAT BAI] Khong the ghi tap tin: " + $_.Exception.Message) -ForegroundColor Red
}
