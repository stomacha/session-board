@echo off
rem Stops the Session Board server on 127.0.0.1:4777 and every session it started.
set found=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4777 " ^| findstr LISTENING') do (set found=1 & taskkill /pid %%p /t /f >nul)
if defined found (echo Session Board stopped.) else (echo Session Board is not running.)
timeout /t 2 >nul
