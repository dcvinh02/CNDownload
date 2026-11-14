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
  echo [2/2] Dang cai cac thanh phan AI ^(Python, model^) - chi lam 1 lan, can Internet...
  node scripts\setup.js --yes
  if errorlevel 1 goto :fail
)

echo Dang khoi dong CN Video Scraper Pro...
node src\launcher.js
exit /b 0

:fail
echo.
echo [!] Cai dat chua thanh cong. Xem thong bao loi o tren, kiem tra Internet roi chay lai file nay.
pause
exit /b 1
