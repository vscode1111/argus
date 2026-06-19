# Launched (fresh, with foreground rights) when an Argus notification toast is clicked.
# A toast-activated process is allowed to switch virtual desktops and steal foreground,
# which a background extension host is not. Finds the VS Code window hosting Argus and
# brings it forward, crossing virtual desktops via SwitchToThisWindow.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ArgusFocus {
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint pid);
}
"@

# Prefer the window whose title mentions Argus; fall back to any titled VS Code window.
$logPath = Join-Path $env:TEMP 'argus-focus-helper.log'
function Log($m) { Add-Content -Path $logPath -Value ("[{0}] {1}" -f (Get-Date -Format o), $m) }
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Log "helper start, elevated=$elevated"

$procs = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' }
$target = $procs | Where-Object { $_.MainWindowTitle -like '*Argus*' } | Select-Object -First 1
if (-not $target) { $target = $procs | Select-Object -First 1 }
if (-not $target) { Log "no VS Code window found"; exit 1 }

$h = $target.MainWindowHandle
Log "target='$($target.MainWindowTitle)' hwnd=$h iconic=$([ArgusFocus]::IsIconic($h))"
[ArgusFocus]::AllowSetForegroundWindow([uint32]::MaxValue) | Out-Null
if ([ArgusFocus]::IsIconic($h)) { [ArgusFocus]::ShowWindowAsync($h, 9) | Out-Null }
[ArgusFocus]::SwitchToThisWindow($h, $true)
[ArgusFocus]::BringWindowToTop($h) | Out-Null
$sf = [ArgusFocus]::SetForegroundWindow($h)
Log "switched; setForeground=$sf"
