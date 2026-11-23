@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo   Robo de Stories do Instagram - instalacao
echo ==============================================
echo.

rem 1) Python
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY python --version >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Python nao encontrado. Tentando instalar pelo winget...
  winget install -e --id Python.Python.3.12 --scope machine --accept-package-agreements --accept-source-agreements
  py -3 --version >nul 2>&1 && set "PY=py -3"
)
if not defined PY (
  echo.
  echo Nao consegui instalar o Python sozinho.
  echo Baixe em https://www.python.org/downloads/ , marque "Add python.exe to PATH" e rode este INSTALAR de novo.
  pause
  exit /b 1
)
%PY% -c "import sys;print(sys.executable)" > python-caminho.txt
set /p PYEXE=<python-caminho.txt
echo Python: %PYEXE%

rem 2) Bibliotecas
echo.
echo Instalando as bibliotecas (instagrapi e pillow)...
"%PYEXE%" -m pip install --upgrade --quiet instagrapi pillow
if errorlevel 1 (
  echo Falhou a instalacao das bibliotecas. Confira a internet e rode de novo.
  pause
  exit /b 1
)

rem 3) Chave (a mesma do robo do WhatsApp) - copiada do config.env dele, sem aparecer na tela
findstr /b /c:"CHAVE=" config.env >nul 2>&1
if errorlevel 1 (
  echo.
  echo Arraste para esta janela o arquivo config.env da pasta do ROBO DO WHATSAPP e aperte Enter:
  set /p "ZAPCFG="
)
findstr /b /c:"CHAVE=" config.env >nul 2>&1
if errorlevel 1 (
  call :copiarchave
)
findstr /b /c:"CHAVE=" config.env >nul 2>&1
if errorlevel 1 (
  echo Nao achei a CHAVE nesse arquivo. Rode o INSTALAR de novo e arraste o config.env certo.
  pause
  exit /b 1
)
echo Chave copiada.

rem 4) Ligar sozinho quando o Windows abrir
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0AGENDAR-STORIES.ps1"
echo Robo agendado: liga sozinho, sem janela, ao entrar no Windows e as 05:55.

rem 5) Conectar o Instagram
echo.
echo Agora vamos conectar o Instagram.
call CONECTAR-INSTAGRAM.bat
echo.
echo Para ligar agora: de dois cliques em INICIAR-STORIES-OCULTO.vbs (ou reinicie o computador).
pause
exit /b 0

:copiarchave
set "ZAPCFG=%ZAPCFG:"=%"
if not exist "%ZAPCFG%" exit /b 0
findstr /b /c:"CHAVE=" "%ZAPCFG%" >> config.env
exit /b 0
