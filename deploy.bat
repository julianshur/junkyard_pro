@echo off
cd /d "%~dp0"
setlocal

set FTP_USER=julianshur@junkyardpro.com
set FTP_HOST=ftp.junkyardpro.com
set FTP_PASS=b1n6b0n61!

set LOCAL_DIR=%cd%
set REMOTE_DIR=/public_html

echo.
echo === Git add ===
git add .

echo.
echo === Git commit ===
git commit -m "Auto deploy"

echo.
echo === Git push ===
git push

echo.
echo === Creating WinSCP script ===

(
echo open ftps://%FTP_USER%:%FTP_PASS%@%FTP_HOST%/
echo option batch continue
echo option confirm off

echo cd %REMOTE_DIR%

echo lcd %LOCAL_DIR%

echo put -r *.*

echo exit
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