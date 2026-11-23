@echo off
chcp 65001 >nul
cd /d "%~dp0"
:laco
node atualizar.js >> robo.log 2>&1
node robo.js >> robo.log 2>&1
echo %date% %time% - o robo parou, reiniciando em 10 segundos >> robo.log
ping -n 11 127.0.0.1 >nul
goto laco
