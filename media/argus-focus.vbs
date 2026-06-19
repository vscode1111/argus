' Windowless launcher for the argus-focus:// protocol (toast click). Runs the focus
' PowerShell script (arg 0) fully hidden via WScript.Shell.Run with window style 0, so
' no console flashes. The PowerShell helper - a fresh, foreground-righted process -
' performs the actual window switch (a background extension host cannot switch desktops).
Dim sh, ps1
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count >= 1 Then
  ps1 = WScript.Arguments(0)
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
End If
