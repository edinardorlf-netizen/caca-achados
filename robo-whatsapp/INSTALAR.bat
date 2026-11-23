@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Instalando o robo (so na primeira vez)...
call npm install
echo.
echo Pronto. Agora de dois cliques em CONECTAR.bat
pause
