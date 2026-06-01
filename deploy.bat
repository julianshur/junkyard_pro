@echo off
cd /d "%~dp0"
setlocal

set FTP_USER=julianshur@junkyardpro.com
set FTP_HOST=.../public_html/junkyardpro.com

REM Enter your FTP password here or prompt for it
set FTP_PASS=b1n6b0n61!

echo.
echo === Git add ===
git add .

echo.
echo === Git commit ===
set MSG=Auto deploy
git commit -m "%MSG%"

echo.
echo === Git push ===
git push

echo.
echo === Creating WinSCP script ===

(
open ftps://%FTP_USER%:%FTP_PASS%@ftp.junkyardpro.com/ -explicit
option batch continue
option confirm off

cd ..
pwd
ls

cd ..
pwd
ls

exit
) > winscp_script.txt

echo.
echo === Connecting to Turbify ===

"C:\Program Files (x86)\WinSCP\WinSCP.com" ^
  /log=winscp.log ^
  /script=winscp_script.txt

echo.
echo === WinSCP Log Saved To winscp.log ===

del winscp_script.txt

pause