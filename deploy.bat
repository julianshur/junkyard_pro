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
 "open ftp://julianshur%%40junkyardpro.com:b1n6b0n6@ftp.junkyardpro.com/ -passive=on" ^
 "option batch on" ^
 "option confirm off" ^
 "lcd %REPO%" ^
 "cd /public_html" ^
 "put server.js /home/byoq1zt2rc5qg23e/public_html" ^
 "put package.json /home/byoq1zt2rc5qg23e/public_html" ^
 "put public/index.html /home/byoq1zt2rc5qg23e/public_html" ^
 "exit"

echo.
echo === DONE ===
pause