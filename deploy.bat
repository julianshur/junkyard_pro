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
echo === FTP deploy ===

powershell -NoProfile -Command "Set-Content -Path '%REPO%\winscp_deploy.txt' -Encoding ascii -Value @('open ftp://julianshur%%40junkyardpro.com:b1n6b0n61!@ftp.junkyardpro.com/ -passive=on','option batch on','option confirm off','lcd %REPO%\public','put index.html','put app.js','put styles.css','exit'); & 'C:\Program Files (x86)\WinSCP\WinSCP.com' /script='%REPO%\winscp_deploy.txt' /log='%REPO%\deploy.log' /loglevel=1; Write-Host 'Exit code:' $LASTEXITCODE"

echo.
echo === Cloudflare Worker deploy ===
npx wrangler deploy

echo.
echo === DONE ===
