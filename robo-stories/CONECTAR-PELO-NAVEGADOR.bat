@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set /p PYEXE=<python-caminho.txt
"%PYEXE%" conectar_sessao.py
echo.
pause
