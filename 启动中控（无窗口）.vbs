Rem Start the Focus hub without a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
hubDir = fso.GetParentFolderName(WScript.ScriptFullName) & "\hub"
CreateObject("WScript.Shell").Run "cmd /c cd /d """ & hubDir & """ && npm start", 0, False
