@echo off
chcp 65001 >nul
schtasks /Delete /TN "Robo Achados - Ligar" /F
schtasks /Delete /TN "Robo Achados - Hibernar" /F
echo Agendamento removido.
pause
