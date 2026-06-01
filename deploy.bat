"C:\Program Files (x86)\WinSCP\WinSCP.com" ^
 /log=deploy.log ^
 /command ^
 "open junkyard_ftp" ^
 "cd /" ^
 "put ""%REPO%\server.js"" /server.js" ^
 "put ""%REPO%\package.json"" /package.json" ^
 "put ""%REPO%\public\index.html"" /index.html" ^
 "synchronize remote -filemask=""|.git/;node_modules/;deploy.log;*.md;*.env"" -delete" ^
 "exit"