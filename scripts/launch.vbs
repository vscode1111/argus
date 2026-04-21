Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launchJs = fso.BuildPath(scriptDir, "launch.js")

dir = ""
If WScript.Arguments.Count > 0 Then dir = WScript.Arguments(0)

cmd = "node """ & launchJs & """ """ & dir & """"
shell.Run cmd, 0, False
