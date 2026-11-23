# Agenda no Windows o robô de Stories, igual ao robô do WhatsApp:
#  - liga sozinho (sem janela) sempre que você entra no Windows (ligou, reiniciou, voltou de queda de energia);
#  - às 05:55 acorda o computador e liga o robô de novo, se ele tiver parado.
# Se já estiver ligado, não abre outro. Para mudar o horário, edite a linha abaixo e rode AGENDAR-STORIES.bat de novo.
$horaLigar = '05:55'

$pasta = $PSScriptRoot
$cfg = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
$acao = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $pasta + '\INICIAR-STORIES-OCULTO.vbs"') -WorkingDirectory $pasta
$gatilhos = @(
  (New-ScheduledTaskTrigger -Daily -At $horaLigar),
  (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME")
)
Register-ScheduledTask -TaskName 'Robo Achados - Stories' -Action $acao -Trigger $gatilhos -Settings $cfg -Force | Out-Null

# O atalho antigo da pasta Inicializar fazia a mesma coisa: sai para não ligar duas vezes.
$atalho = Join-Path ([Environment]::GetFolderPath('Startup')) 'Robo de Stories.lnk'
if (Test-Path $atalho) { Remove-Item $atalho -Force }

Write-Host "Pronto: o robô de Stories liga sozinho (sem janela) ao entrar no Windows e às $horaLigar."
