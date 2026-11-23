# Agenda no Windows:
#  - o robô liga sozinho sempre que você entra no Windows (ligou o computador, reiniciou, voltou de queda de energia);
#  - acorda o computador e liga o robô às 05:55;
#  - para o robô e hiberna às 04:05 (fora do horário de postagem, que vai das 6h às 4h).
# Para mudar os horários, edite as duas linhas abaixo (formato HH:MM) e rode AGENDAR.bat de novo.
# Para nunca hibernar, deixe $horaDesligar = ''
$horaLigar = '05:55'
$horaDesligar = '04:05'

$pasta = $PSScriptRoot
$cfg = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

$aLigar = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $pasta + '\INICIAR-OCULTO.vbs"')
$tLigar = @(
  (New-ScheduledTaskTrigger -Daily -At $horaLigar),
  (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME")
)
Register-ScheduledTask -TaskName 'Robo Achados - Ligar' -Action $aLigar -Trigger $tLigar -Settings $cfg -Force | Out-Null

if ($horaDesligar) {
  $aDesl = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $pasta + '\PARAR-E-HIBERNAR.bat"')
  $tDesl = New-ScheduledTaskTrigger -Daily -At $horaDesligar
  Register-ScheduledTask -TaskName 'Robo Achados - Hibernar' -Action $aDesl -Trigger $tDesl -Settings $cfg -Force | Out-Null
  Write-Host "Pronto: o robô liga ao entrar no Windows e às $horaLigar; o computador hiberna às $horaDesligar."
} else {
  schtasks /Delete /TN "Robo Achados - Hibernar" /F 2>$null | Out-Null
  Write-Host "Pronto: o robô liga ao entrar no Windows e às $horaLigar. O computador não hiberna."
}
Write-Host "Se o computador não acordar sozinho, ligue 'Permitir cronômetros de ativação' nas Opções de Energia."
