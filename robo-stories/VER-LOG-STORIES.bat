@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist stories.log echo (ainda sem registros) > stories.log
powershell -NoProfile -NoExit -Command "Get-Content stories.log -Tail 40 -Wait -Encoding UTF8"
