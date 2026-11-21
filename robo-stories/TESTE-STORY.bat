@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set /p PYEXE=<python-caminho.txt
echo Vai postar 1 Story agora (a melhor oferta), com a figurinha de link.
"%PYEXE%" robo_stories.py teste
pause
