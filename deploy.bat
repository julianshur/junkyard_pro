"C:\Program Files (x86)\WinSCP\WinSCP.com" ^
 /log=deploy.log ^
 /loglevel=2 ^
 /command ^
 "open junkyard_ftp" ^
 "option confirm off" ^
 "option batch on" ^
 "cd /" ^
 "put ""%REPO%\server.js"" /server.js" ^
 "put ""%REPO%\package.json"" /package.json" ^
 "put ""%REPO%\public\index.html"" /index.html" ^
 "exit"