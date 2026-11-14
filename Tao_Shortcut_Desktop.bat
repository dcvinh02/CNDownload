@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Tao loi tat "CN Video Scraper Pro" tren Desktop tro toi Start_App_Windows.bat (cua so dong lenh thu nho)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'CN Video Scraper Pro.lnk')); $s.TargetPath=(Join-Path (Get-Location) 'Start_App_Windows.bat'); $s.WorkingDirectory=(Get-Location).Path; $s.WindowStyle=7; $s.Description='CN Video Scraper Pro'; $s.Save(); Write-Host ('Da tao loi tat: ' + (Join-Path $d 'CN Video Scraper Pro.lnk'))"
if errorlevel 1 (
  echo [!] Khong tao duoc loi tat. Co the tu tao: chuot phai Start_App_Windows.bat - Send to - Desktop.
)
if not "%~1"=="--quiet" pause
