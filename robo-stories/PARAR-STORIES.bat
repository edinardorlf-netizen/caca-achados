@echo off
chcp 65001 >nul
rem Para só o robô de Stories (não mexe no robô do WhatsApp nem no de lances).
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*INICIAR-STORIES.bat*' -or $_.CommandLine -like '*robo_stories.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo Robo de Stories parado. Para ligar de novo: INICIAR-STORIES-OCULTO.vbs
pause
