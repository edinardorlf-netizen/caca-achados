' Liga o robô de Stories sem janela. A saída fica em stories.log (use VER-LOG-STORIES.bat).
' Se já estiver ligado, não abre outro.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set ligados = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE CommandLine LIKE '%INICIAR-STORIES.bat%' OR CommandLine LIKE '%robo_stories.py%'")
If ligados.Count > 0 Then WScript.Quit
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta
sh.Run "cmd /c """ & pasta & "\INICIAR-STORIES.bat""", 0, False
