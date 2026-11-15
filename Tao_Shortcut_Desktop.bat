@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Tao loi tat "CN Video Scraper Pro" tren Desktop: tro toi CNVideoScraperPro.exe (ung dung doc lap) neu co,
rem neu chua dung exe thi tro toi Start_App_Windows.bat (cua so dong lenh thu nho)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$here=(Get-Location).Path; $exe=Join-Path $here 'CNVideoScraperPro.exe'; $d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'CN Video Scraper Pro.lnk')); if (Test-Path $exe) { $s.TargetPath=$exe; $s.WindowStyle=1; $s.IconLocation=$exe } else { $s.TargetPath=(Join-Path $here 'Start_App_Windows.bat'); $s.WindowStyle=7; $s.IconLocation=(Join-Path $here 'public\icon.ico') }; $s.WorkingDirectory=$here; $s.Description='CN Video Scraper Pro'; $s.Save(); Write-Host ('Da tao loi tat: ' + (Join-Path $d 'CN Video Scraper Pro.lnk') + ' -> ' + $s.TargetPath)"
if errorlevel 1 (
  echo [!] Khong tao duoc loi tat. Co the tu tao: chuot phai Start_App_Windows.bat - Send to - Desktop.
)
if not "%~1"=="--quiet" pause
