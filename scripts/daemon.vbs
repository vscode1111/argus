' Windowless launcher for the Argus daemon. Runs node on the compiled
' out\backend\daemon.js detached from any console (window style 0), so the daemon
' keeps running after the launching shell closes and self-exits when idle.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
daemonJs = fso.BuildPath(scriptDir, "..\out\backend\daemon.js")

cmd = "node """ & daemonJs & """"
shell.Run cmd, 0, False
