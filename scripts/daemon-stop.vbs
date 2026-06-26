' Windowless launcher for stopping the Argus daemon. Runs node on
' daemon-stop.js hidden (window style 0) and detached so no console flashes when
' invoked from the "Stop Argus daemon" context-menu entry. daemon-stop.js is
' idempotent (exits 0 when nothing is running).
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
stopJs = fso.BuildPath(scriptDir, "daemon-stop.js")

cmd = "node """ & stopJs & """"
shell.Run cmd, 0, False
