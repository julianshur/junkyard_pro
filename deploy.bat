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
 "open ftp://julianshur%%40junkyardpro.com:b1n6b0n61!@ftp.junkyardpro.com/ -passive=on" ^
 "option batch on" ^
 "option confirm off" ^
 "lcd %REPO%" ^
 "put server.js /public_html/server.js" ^
 "put package.json /public_html/package.json" ^
 "lcd %REPO%\public" ^
 "put index.html /public_html/index.html" ^
 "put app.js /public_html/app.js" ^
 "put styles.css /public_html/styles.css" ^
 "exit"

echo.
echo === DONE ===
pause