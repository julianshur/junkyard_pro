@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0.."

set FTP_USER=julianshur@junkyardpro.com
set FTP_HOST=ftp.junkyardpro.com
set FTP_PASS=b1n6b0n61!

set REMOTE_DIR=/
set STATE_FILE=deploy\state.txt

echo ================================
echo   MINI CI/CD DEPLOY SYSTEM
echo ================================

echo.
echo === Git commit check ===
git add .

git diff --cached --quiet
if %errorlevel%==0 (
    echo No changes to commit. Continuing deploy...
) else (
    git commit -m "Auto deploy"
)

echo.
echo === Git push ===
git push

echo.
echo === Determining changed files ===

if not exist %STATE_FILE% (
    echo First deploy - using HEAD
    git rev-parse HEAD > %STATE_FILE%
)

set /p LAST_DEPLOY=<%STATE_FILE%

echo Last deployed commit: %LAST_DEPLOY%
for /f %%i in ('git rev-parse HEAD') do set მიმდინარე=%%i
set CURRENT=!მიმდინარე!

echo Current commit: !CURRENT!

git diff --name-only %LAST_DEPLOY% !CURRENT! > deploy\files.txt

echo.
echo === Building WinSCP script ===

(
echo option batch continue
echo option confirm off

echo open ftp://%FTP_USER%:%FTP_PASS%@%FTP_HOST%:21/ -passive=on

echo lcd %LOCAL_DIR%
echo cd /

echo synchronize remote

echo exit
) > winscp_script.txt

echo exit
) > deploy\winscp_script.txt

echo.
echo === Deploying via WinSCP ===

"C:\Program Files (x86)\WinSCP\WinSCP.com" ^
 /log=deploy\deploy.log ^
 /script=deploy\winscp_script.txt

echo.
echo === Updating deploy state ===
echo !CURRENT! > %STATE_FILE%

echo.
echo === CLEANUP ===
del deploy\winscp_script.txt
del deploy\files.txt

echo.
echo === DEPLOY COMPLETE ===
pause