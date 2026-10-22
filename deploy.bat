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

if "%FTP_USER%"=="" (
    echo ERROR: FTP_USER environment variable is not set.
    exit /b 1
)
if "%FTP_PASSWORD%"=="" (
    echo ERROR: FTP_PASSWORD environment variable is not set.
    exit /b 1
)

powershell -NoProfile -Command "$u=[uri]::EscapeDataString($env:FTP_USER); $p=[uri]::EscapeDataString($env:FTP_PASSWORD); Set-Content -Path '%REPO%\winscp_deploy.txt' -Encoding ascii -Value @(('open ftp://' + $u + ':' + $p + '@ftp.junkyardpro.com/ -passive=on'),'option batch on','option confirm off','lcd %REPO%\public','put index.html','put app.js','put styles.css','exit'); & 'C:\Program Files (x86)\WinSCP\WinSCP.com' /script='%REPO%\winscp_deploy.txt' /log='%REPO%\deploy.log' /loglevel=1; Write-Host 'Exit code:' $LASTEXITCODE"

echo.
echo === Cloudflare Worker deploy ===
npx wrangler deploy

echo.
echo === DONE ===
