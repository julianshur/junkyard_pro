@echo off
setlocal

set "REPO_DIR=C:\Users\Julian\Documents\git\junkyard_pro"

echo ==========================
echo   SIMPLE DEPLOY SYSTEM
echo ==========================

echo.
echo === Git commit/push ===
cd /d "%REPO_DIR%"

git add .

git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Auto deploy"
)

git push

echo.
echo === Deploy via WinSCP ===

"C:\Program Files (x86)\WinSCP\WinSCP.com" ^
 /log=deploy.log ^
 /command ^
 "open junkyard_ftp" ^
 "lcd ""%REPO_DIR%""" ^
 "cd /" ^
 "synchronize remote" ^
 "exit"

echo.
echo === DONE ===
pause