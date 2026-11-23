@echo off
chcp 65001 >nul
cd /d "%~dp0"
node robo.js teste
pause
