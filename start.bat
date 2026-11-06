@echo off
cd /d "%~dp0"
rem 서버를 숨김 창으로 켜고, 주소창 없는 앱 창으로 화면을 연다
start "" /b node server.ts
timeout /t 2 >nul
start "" msedge --app=http://127.0.0.1:4777
