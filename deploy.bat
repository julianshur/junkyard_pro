@echo off
setlocal

set "REPO=C:\Users\Julian\Documents\git\junkyard_pro"

echo ==========================
echo   ZERO-BUG DEPLOY
echo ==========================

cd /d "%REPO%" || exit /b 1

echo.
echo === Git push ===
git add -A
git commit -m "deploy" >nul 2>&1
git push

echo.
echo === WinSCP deploy ===

powershell -NoProfile -Command ^
  "$s='open ftp://julianshur%%40junkyardpro.com:b1n6b0n61!@ftp.junkyardpro.com/ -passive=on`noption batch on`noption confirm off`nlcd %REPO%`nput server.js`nput package.json`nlcd %REPO%\public`nput index.html`nput app.js`nput styles.css`nexit'; $s | Out-File -Encoding ascii '%REPO%\winscp_deploy.txt'; & 'C:\Program Files (x86)\WinSCP\WinSCP.com' /script='%REPO%\winscp_deploy.txt' /log='%REPO%\deploy.log' /loglevel=1; Write-Host 'Exit code:' $LASTEXITCODE"

echo.
echo === DONE ===
