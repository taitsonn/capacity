@echo off
cd /d "%~dp0"

set "PATH=C:\Program Files\nodejs;%PATH%"
set "ALLOWED_HOSTS=192.168.230.123:5173"

node scripts/server.mjs

if errorlevel 1 pause