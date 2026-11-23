@echo off
chcp 65001 >nul
cd /d "%~dp0"
:laco
node atualizar.js
node robo.js
echo O robo parou. Reiniciando em 10 segundos...
timeout /t 10 >nul
goto laco
