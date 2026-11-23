@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*INICIAR-LOG*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
taskkill /f /im node.exe >nul 2>&1
echo Robo parado.
pause
