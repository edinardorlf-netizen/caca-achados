@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set /p PYEXE=<python-caminho.txt
echo Mostra quem o robo seguiria (curtidas dos perfis de referencia). Ninguem e seguido neste teste.
"%PYEXE%" robo_stories.py seguir-teste
pause
