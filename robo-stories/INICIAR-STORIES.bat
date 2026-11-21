@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set /p PYEXE=<python-caminho.txt
:laco
"%PYEXE%" robo_stories.py >> stories.log 2>&1
echo %date% %time% - o robo de Stories parou, reiniciando em 30 segundos >> stories.log
ping -n 31 127.0.0.1 >nul
goto laco
