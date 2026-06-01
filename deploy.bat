@echo off
setlocal

set "REPO_DIR=C:\Users\Julian\Documents\git\junkyard_pro"

echo ==========================
echo   TARGETED DEPLOY
echo ==========================

echo.
echo === Git commit/push ===
cd /d "%REPO_DIR%"

git add server.js public/index.html package.json

git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Auto deploy (targeted files)"
)

git push

echo.
echo === Deploy via WinSCP ===

"C:\Program Files (x86)\WinSCP\WinSCP.com" ^
 /log=deploy.log ^
 /command ^
 "open junkyard_ftp" ^
 "cd /" ^
 "lcd C:\Users\Julian\Documents\git\junkyard_pro" ^
 "put server.js /server.js" ^
 "put package.json /package.json" ^
 "put public/index.html public/index.html" ^
 "exit"

echo.
echo === DONE ===
pause