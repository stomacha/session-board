@echo off
cd /d "%~dp0"
rem Server runs with no window, so closing a console can't kill it (stop it with stop.bat). Output goes to server.log.
rem If it is already running, just open the board.
netstat -ano | findstr ":4777 " | findstr LISTENING >nul && goto open
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath cmd.exe -ArgumentList '/d','/c','node server.ts >> server.log 2>&1' -WorkingDirectory '%~dp0.' -WindowStyle Hidden"
timeout /t 2 >nul
:open
start "" msedge --app=http://127.0.0.1:4777
