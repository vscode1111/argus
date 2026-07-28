# Issue: toast click does not focus VS Code (cross virtual desktop)

Status: **open / unverified fix in working tree**
Area: `notify-on-complete` -> Windows OS toast -> click-to-focus
First captured: 2026-06-19

## Symptom

When `notifyOnComplete` is on, a turn finishing fires a real Windows OS toast
(Action Center) via `showWindowsToast` (`src/frontend/utils/win32Toast.ts`).
Clicking the toast is supposed to bring the VS Code window to the foreground and
reveal the last-focused Argus chat panel. It does not reliably do so, especially
when VS Code lives on a **different virtual desktop** than the one currently
active. The window at best flashes in the taskbar instead of switching.

## Root cause (Windows foreground/desktop restrictions)

A clicked toast can only hand a URI back to the shell. The process that ends up
handling it (the VS Code extension host, via the `vscode://` Uri handler) is a
**background process** and Windows denies it the right to:

- steal foreground (`SetForegroundWindow` is demoted to a taskbar flash), and
- switch the active **virtual desktop**.

`SetForegroundWindow`/`panel.reveal()`/`vscode://` launch all stay on the
current desktop. Only `SwitchToThisWindow` (the Alt+Tab API) crosses desktops,
and even that needs the caller to actually hold foreground/input rights.

## Hard evidence (real attempt)

`%TEMP%\argus-focus.log` captured one real toast click at `2026-06-18T22:39:21`,
which went through the **old `vscode://` path** (`revealForActivation` ->
`focusCachedWindow`):

```
revealForActivation: panels=1 hasTarget=true
focus start: hasHwnd=true iconic=false
lock timeout was 200000, cleared=false   <- SpiSetTimeout to zero the foreground lock FAILED
attached=false setForeground=false        <- AttachThreadInput AND SetForegroundWindow both FAILED
focus end
```

Reading: the extension host had no foreground rights, so even
`SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0)` was rejected
(`cleared=false`), `AttachThreadInput` failed (`attached=false`), and
`SetForegroundWindow` returned false. This confirms the in-process approach
cannot work from a background extension host: Windows simply will not grant it
foreground/desktop-switch rights.

There is **no** `%TEMP%\argus-focus-helper.log`, so the newer VBS -> PS1 helper
path (see Attempt 3) has **never actually fired / been verified** yet.

## Attempts

### Attempt 1 - `vscode://<extensionId>/focus` protocol + reveal (original, committed in 1f1d168)
Toast XML carries `activationType='protocol' launch='vscode://<id>/focus'`.
Shell ShellExecutes it, VS Code routes to the `UriHandler` (`extension.ts`),
which calls `ChatPanel.revealForActivation()` -> `panel.reveal()`.
**Result:** does not cross virtual desktops; `panel.reveal()` alone never raises
the OS window across desktops. Insufficient.

### Attempt 2 - in-process Win32 dance in `focusCachedWindow` (working tree)
`src/frontend/utils/win32Focus.ts` extended to:
- defeat the foreground lock: `SystemParametersInfo` GET/SET
  `SPI_SETFOREGROUNDLOCKTIMEOUT=0` + `AllowSetForegroundWindow(ASFW_ANY)`,
  restored in `finally`;
- `SwitchToThisWindow(hwnd, true)` (crosses desktops) inside the
  `AttachThreadInput` dance with `BringWindowToTop` + `SetForegroundWindow`;
- on-disk diagnostics via `focusDiag()` -> `%TEMP%\argus-focus.log`.
`revealForActivation` now calls `focusCachedWindow(...)` before `panel.reveal()`.
**Result: FAILED** per the log above - a background process is refused all of
these (`cleared=false`, `attached=false`, `setForeground=false`). The Win32 code
is correct in principle but runs in the wrong (rights-less) process.

### Attempt 3 - dedicated `argus-focus://` protocol + fresh foreground-righted helper (working tree, UNVERIFIED)
Key insight: a process *freshly spawned by a shell protocol activation* holds
foreground/input rights, unlike the long-lived background extension host. So:
- `extension.ts` `registerFocusProtocol()` registers
  `HKCU\Software\Classes\argus-focus\shell\open\command` =
  `wscript.exe "media\argus-focus.vbs" "media\argus-focus-switch.ps1" "%1"`.
- Toast `launch` URI changed from `vscode://<id>/focus` to `argus-focus://focus`
  (`ChatPanel.ts`, via new exported `FOCUS_PROTOCOL`).
- `media/argus-focus.vbs` - windowless launcher (WScript.Shell.Run style 0, no
  console flash) that runs the PS1 hidden.
- `media/argus-focus-switch.ps1` - finds the `Code` process whose
  `MainWindowTitle` matches `*Argus*` (else any titled VS Code window) and does
  `AllowSetForegroundWindow` + `ShowWindowAsync` + `SwitchToThisWindow` +
  `BringWindowToTop` + `SetForegroundWindow`; logs to
  `%TEMP%\argus-focus-helper.log`.
**Result: NOT YET VERIFIED** - helper log is absent, meaning the click hasn't
been exercised against this path (or the protocol/registry wiring didn't fire).

## Known inconsistencies to resolve

1. **Stale comment vs implementation.** `ChatPanel.ts` (~line 145) says the
   helper "drops a signal file that this extension host watches"
   (registerFocusProtocol/**watchFocusSignal**). There is **no**
   `watchFocusSignal` in the codebase, and `argus-focus-switch.ps1` performs the
   switch **directly** rather than dropping a signal file. Either implement the
   signal-file + watcher design or fix the comment to describe the direct-switch
   helper.
2. **Two competing focus paths still wired.** Both the new `argus-focus://`
   protocol and the old `vscode://<id>/focus` UriHandler (-> `revealForActivation`
   -> in-process `focusCachedWindow`, proven to fail) are active. Decide which is
   authoritative; the in-process path cannot succeed from the background host.
3. **CustomActivator CLSID** (`win32Toast.ts`, `ACTIVATOR_CLSID`) is a stub with
   no backing COM server. Fine for protocol activation, but confirm the toast
   stays clickable from the Action Center (new e2e asserts the registry value
   exists, not that the click works).

## Next steps to verify Attempt 3

1. Build/reload the extension so `registerFocusProtocol` writes the
   `argus-focus` registry keys; confirm with
   `reg query HKCU\Software\Classes\argus-focus\shell\open\command`.
2. Sanity-test the protocol independent of a toast:
   `Start-Process "argus-focus://focus"` (or run the VBS directly) and watch for
   `%TEMP%\argus-focus-helper.log` plus an actual desktop switch.
3. Fire a real toast (finish a turn with notify-on-complete on) from a *different
   virtual desktop*, click it, and confirm VS Code comes forward.
4. If the helper runs but still doesn't switch, check `MainWindowTitle` matching
   (the panel title may not contain "Argus") and elevation mismatch
   (`elevated=` in the helper log; a non-elevated helper cannot foreground an
   elevated VS Code, and vice versa).
5. Once a path is proven, delete the dead path and reconcile the comments.

## Touched files (working tree, uncommitted)

- `src/frontend/utils/win32Focus.ts` - foreground-lock defeat + `SwitchToThisWindow` + `focusDiag`
- `src/frontend/utils/win32Toast.ts` - stub `CustomActivator` CLSID registration
- `src/frontend/chat/ChatPanel.ts` - `revealForActivation` calls `focusCachedWindow`; toast `launch` -> `argus-focus://focus`
- `src/frontend/extension.ts` - `FOCUS_PROTOCOL`, `registerFocusProtocol()`
- `media/argus-focus.vbs` (new) - windowless launcher
- `media/argus-focus-switch.ps1` (new) - foreground-righted switch helper
- `e2e/win32-toast-integration.spec.ts` - asserts `CustomActivator` registered
- `package.json` - version 0.0.58 -> 0.0.61
