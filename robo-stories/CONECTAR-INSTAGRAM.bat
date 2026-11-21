@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set /p PYEXE=<python-caminho.txt
"%PYEXE%" robo_stories.py conectar
