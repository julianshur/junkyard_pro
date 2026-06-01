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
 /loglevel=1 ^
 /command ^
 "open ftp://julianshur%40junkyardpro.com:***@ftp.junkyardpro.com/" ^
 "option batch on" ^
 "option confirm off" ^
 "lcd %REPO%" ^
 "cd /" ^
 "put server.js /server.js" ^
 "put package.json /package.json" ^
 "put public/index.html /index.html" ^
 "exit"

echo.
echo === DONE ===
pause