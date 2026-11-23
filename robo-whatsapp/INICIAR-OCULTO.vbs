' Liga o robô sem janela. A saída fica gravada em robo.log (use VER-LOG.bat para olhar).
' Se o robô já estiver ligado, não abre outro (o mesmo número conectado duas vezes derruba a sessão).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set ligados = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE CommandLine LIKE '%INICIAR-LOG%' OR CommandLine LIKE '%robo.js%'")
If ligados.Count > 0 Then WScript.Quit
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
sh.Run "cmd /c """ & pasta & "\INICIAR-LOG.bat""", 0, False
