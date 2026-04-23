import koffi from 'koffi';

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
};

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
  if (!a) { log('koffi unavailable'); return; }
  if (!cachedHwnd) cachedHwnd = a.GetForegroundWindow();
  if (!cachedHwnd) { log('koffi: no cached hwnd'); return; }
  try {
    a.keybd_event(0x12, 0, 0, 0n);
    const fg = a.GetForegroundWindow();
    const fgTid = [0];
    a.GetWindowThreadProcessId(fg, fgTid);
    const myTid = a.GetCurrentThreadId();
    a.AttachThreadInput(fgTid[0], myTid, true);
    try {
      if (a.IsIconic(cachedHwnd)) a.ShowWindowAsync(cachedHwnd, 9);
      a.BringWindowToTop(cachedHwnd);
      const r = a.SetForegroundWindow(cachedHwnd);
      log(`koffi: setForeground=${r}`);
    } finally {
      a.AttachThreadInput(fgTid[0], myTid, false);
    }
  } finally {
    a.keybd_event(0x12, 0, 2, 0n);
  }
}
