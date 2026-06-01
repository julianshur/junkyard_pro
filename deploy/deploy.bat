@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0.."

set "FTP_USER=julianshur@junkyardpro.com"
set "FTP_HOST=ftp.junkyardpro.com"
set "FTP_PASS=b1n6b0n61!"
set "REMOTE_DIR=/"

echo.
echo === Git add / commit / push ===
git add .

git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Auto deploy"
)

git push

echo.
echo === Determining changed files ===

for /f %%i in ('git rev-parse HEAD~1') do set "LAST=%%i"
for /f %%i in ('git rev-parse HEAD') do set "CURRENT=%%i"

echo Last deployed commit: !LAST!
echo Current commit: !CURRENT!

if not exist deploy mkdir deploy

git diff --name-only !LAST! !CURRENT! > deploy\files.txt

echo.
echo === Building WinSCP script ===

REM Get absolute path safely
for %%I in ("%~dp0..") do set "LOCAL_DIR=%%~fI"

(
echo option batch continue
echo option confirm off
echo option transfer passive
echo open ftp://%FTP_USER%:%FTP_PASS%@%FTP_HOST%:21/
echo lcd "%LOCAL_DIR%"
echo cd %REMOTE_DIR%

for /f "delims=" %%F in (deploy\files.txt) do (
    echo put "%%F" "/%%F"
)

echo exit
) > deploy\winscp_script.txt

if not exist deploy\winscp_script.txt (
    echo ERROR: WinSCP script was not created!
    exit /b 1
)

echo.
echo === Deploying via WinSCP ===

"C:\Program Files (x86)\WinSCP\WinSCP.com" ^
 /log=deploy\winscp.log ^
 /script=deploy\winscp_script.txt

echo.
echo === Updating state ===
echo !CURRENT! > deploy\state.txt

echo.
echo === Cleanup ===
del deploy\files.txt
del deploy\winscp_script.txt

echo.
echo === DEPLOY COMPLETE ===
pause