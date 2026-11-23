@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist robo.log echo (ainda sem registros) > robo.log
powershell -NoProfile -NoExit -Command "Get-Content robo.log -Tail 40 -Wait -Encoding UTF8"
