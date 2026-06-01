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

"C:\Program Files (x86)\WinSCP\WinSCP.com" ^
 /log=deploy.log ^
 /script=winscp.txt

echo.
echo === DONE ===
pause