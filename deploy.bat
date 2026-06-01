@echo off
cd /d "%~dp0"
setlocal

set FTP_USER=julianshur@junkyardpro.com
set FTP_HOST=ftp.junkyardpro.com
set REMOTE_DIR=public_html

echo Enter FTP password:
set FTP_PASS=b1n6b0n61!

echo.
echo === Git add ===
git add .

echo === Git commit ===
#set /p MSG="Commit message (or press enter): "
#if "%MSG%"=="" set MSG=Auto deploy
set MSG=Auto deploy
git commit -m "%MSG%"
git push

echo.
echo === Creating WinSCP script ===
(
echo open ftps://%FTP_USER%:%FTP_PASS%@%FTP_HOST%/ -explicit
echo option batch abort
echo option confirm off
echo cd %REMOTE_DIR%
echo synchronize remote . .
echo exit
echo ===ls===
) > winscp_script.txt

echo === Uploading to Turbify ===
"C:\Program Files (x86)\WinSCP\WinSCP.com" /script=winscp_script.txt

del winscp_script.txt

echo.
echo === DONE ===
pause