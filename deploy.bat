@echo off
cd /d "%~dp0"
setlocal

set FTP_USER=julianshur@junkyardpro.com
set FTP_HOST=ftp.junkyardpro.com

REM Enter your FTP password here or prompt for it
set /p FTP_PASS=FTP Password:

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
echo open ftps://%FTP_USER%:%FTP_PASS%@%FTP_HOST%/ -explicit
echo option batch continue
echo option confirm off
echo echo ===== CURRENT DIRECTORY =====
echo pwd
echo echo ===== DIRECTORY LISTING =====
echo ls
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