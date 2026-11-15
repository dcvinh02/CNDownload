@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title CN Video Scraper Pro

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Chua cai Node.js 20+. Tai tai: https://nodejs.org  ^(ban LTS, Windows Installer^)
  pause
  exit /b 1
)

if not exist "node_modules\express" (
  echo [1/2] Lan dau chay: dang cai thu vien Node ^(npm install^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto :fail
)

node scripts\setup.js --check >nul 2>nul
if errorlevel 1 (
  echo [2/2] Chon cac thanh phan AI can cai ^(Python, model^) - moi muc deu hoi truoc, can Internet...
  node scripts\setup.js
  if errorlevel 1 goto :fail
  if not exist "%USERPROFILE%\Desktop\CN Video Scraper Pro.lnk" call "%~dp0Tao_Shortcut_Desktop.bat" --quiet
)

echo Dang khoi dong CN Video Scraper Pro... (cua so ung dung se tu mo)
echo Giu cua so den nay mo trong khi dung. Dong no (hoac dong cua so ung dung) de tat ung dung.
node src\launcher.js
exit /b 0

:fail
echo.
echo [!] Cai dat chua thanh cong. Xem thong bao loi o tren, kiem tra Internet roi chay lai file nay.
pause
exit /b 1
