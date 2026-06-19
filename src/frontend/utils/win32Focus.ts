import koffi from 'koffi';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Temporary on-disk diagnostics so a notification-click focus attempt can be
// inspected after the fact (the click happens with no console attached).
const FOCUS_LOG = path.join(os.tmpdir(), 'argus-focus.log');
export function focusDiag(line: string): void {
  try { fs.appendFileSync(FOCUS_LOG, `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
}
const diag = focusDiag;

type Api = {
  GetForegroundWindow: () => unknown;
  SetForegroundWindow: (h: unknown) => boolean;
  ShowWindowAsync: (h: unknown, n: number) => boolean;
  BringWindowToTop: (h: unknown) => boolean;
  IsIconic: (h: unknown) => boolean;
  GetWindowThreadProcessId: (h: unknown, out: number[]) => number;
  AttachThreadInput: (a: number, b: number, attach: boolean) => boolean;
  keybd_event: (vk: number, scan: number, flags: number, extra: bigint) => void;
  GetCurrentThreadId: () => number;
  // Used by the Alt+Tab switcher; unlike SetForegroundWindow it crosses virtual
  // desktops, switching to the desktop that hosts the target window.
  SwitchToThisWindow: (h: unknown, altTab: boolean) => void;
  // Defeat the foreground lock that otherwise demotes activation to a taskbar flash.
  SpiGetTimeout: (action: number, p1: number, out: unknown, ini: number) => boolean;
  SpiSetTimeout: (action: number, p1: number, value: number, ini: number) => boolean;
  AllowSetForegroundWindow: (pid: number) => boolean;
};

const SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
const SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
const SPIF_SENDCHANGE = 0x2;
const ASFW_ANY = 0xffffffff;

let api: Api | null = null;
let attempted = false;

function getApi(): Api | null {
  if (attempted) return api;
  attempted = true;
  if (process.platform !== 'win32') return null;
  try {
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    api = {
      GetForegroundWindow: user32.func('void* GetForegroundWindow()'),
      SetForegroundWindow: user32.func('bool SetForegroundWindow(void* hWnd)'),
      ShowWindowAsync: user32.func('bool ShowWindowAsync(void* hWnd, int nCmdShow)'),
      BringWindowToTop: user32.func('bool BringWindowToTop(void* hWnd)'),
      IsIconic: user32.func('bool IsIconic(void* hWnd)'),
      GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void* hWnd, _Out_ uint32* pid)'),
      AttachThreadInput: user32.func('bool AttachThreadInput(uint32 a, uint32 b, bool attach)'),
      keybd_event: user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr extra)'),
      GetCurrentThreadId: kernel32.func('uint32 GetCurrentThreadId()'),
      SwitchToThisWindow: user32.func('void SwitchToThisWindow(void* hWnd, bool fAltTab)'),
      // Two views of SystemParametersInfoW: GET writes the timeout to an out pointer,
      // SET passes the new timeout by value (cast to a pointer-sized int).
      SpiGetTimeout: user32.func('SystemParametersInfoW', 'bool', ['uint', 'uint', 'void *', 'uint']),
      SpiSetTimeout: user32.func('SystemParametersInfoW', 'bool', ['uint', 'uint', 'uintptr', 'uint']),
      AllowSetForegroundWindow: user32.func('bool AllowSetForegroundWindow(uint32 dwProcessId)'),
    };
    return api;
  } catch {
    return null;
  }
}

let cachedHwnd: unknown = null;

export function captureForegroundWindow(): void {
  const a = getApi();
  if (!a) return;
  const hwnd = a.GetForegroundWindow();
  if (hwnd) cachedHwnd = hwnd;
}

export function focusCachedWindow(log: (text: string) => void): void {
  const a = getApi();
  if (!a) { log('koffi unavailable'); diag('koffi unavailable'); return; }
  if (!cachedHwnd) cachedHwnd = a.GetForegroundWindow();
  if (!cachedHwnd) { log('koffi: no cached hwnd'); diag('no cached hwnd'); return; }
  diag(`focus start: hasHwnd=true iconic=${a.IsIconic(cachedHwnd)}`);
  // Windows demotes a background process's activation request to a flashing taskbar
  // button (the "foreground lock"). The extension host isn't the foreground process
  // when a toast forwards the click, so we briefly zero the lock timeout - that lets
  // SwitchToThisWindow/SetForegroundWindow actually switch desktops and raise instead
  // of just blinking. The timeout is restored in finally.
  let prevTimeout = 0;
  let timeoutCleared = false;
  try {
    const to = koffi.alloc('uint32', 1);
    if (a.SpiGetTimeout(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, to, 0)) {
      prevTimeout = koffi.decode(to, 'uint32') as number;
      const setOk = a.SpiSetTimeout(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, 0, SPIF_SENDCHANGE);
      timeoutCleared = true;
      diag(`lock timeout was ${prevTimeout}, cleared=${setOk}`);
    } else {
      diag('SpiGetTimeout failed');
    }
    a.AllowSetForegroundWindow(ASFW_ANY);

    if (a.IsIconic(cachedHwnd)) a.ShowWindowAsync(cachedHwnd, 9);
    a.keybd_event(0x12, 0, 0, 0n);
    const fg = a.GetForegroundWindow();
    const fgTid = [0];
    a.GetWindowThreadProcessId(fg, fgTid);
    const myTid = a.GetCurrentThreadId();
    const attached = a.AttachThreadInput(fgTid[0], myTid, true);
    try {
      // SwitchToThisWindow crosses virtual desktops (SetForegroundWindow does not):
      // it switches to the desktop hosting the window and activates it.
      a.SwitchToThisWindow(cachedHwnd, true);
      a.BringWindowToTop(cachedHwnd);
      const r = a.SetForegroundWindow(cachedHwnd);
      log(`koffi: setForeground=${r}`);
      diag(`attached=${attached} setForeground=${r}`);
    } finally {
      a.AttachThreadInput(fgTid[0], myTid, false);
    }
  } finally {
    a.keybd_event(0x12, 0, 2, 0n);
    if (timeoutCleared) a.SpiSetTimeout(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, prevTimeout, SPIF_SENDCHANGE);
    diag('focus end');
  }
}
