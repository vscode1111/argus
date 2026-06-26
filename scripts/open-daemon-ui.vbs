' Windowless launcher invoked by the "Open Argus (daemon)" context-menu entry.
' Runs node on open-daemon-ui.js with the clicked file path, hidden (window style
' 0) and detached so no console flashes and it outlives the Explorer verb.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launchJs = fso.BuildPath(scriptDir, "open-daemon-ui.js")

target = ""
If WScript.Arguments.Count > 0 Then target = WScript.Arguments(0)

cmd = "node """ & launchJs & """ """ & target & """"
shell.Run cmd, 0, False
