import * as fs from 'fs';
import koffi from 'koffi';

type Api = {
  OpenClipboard: (hwnd: null) => boolean;
  EmptyClipboard: () => boolean;
  SetClipboardData: (fmt: number, hMem: unknown) => unknown;
  CloseClipboard: () => boolean;
  RegisterClipboardFormatW: (name: string) => number;
  GlobalAlloc: (flags: number, bytes: number) => unknown;
  GlobalLock: (hMem: unknown) => unknown;
  GlobalUnlock: (hMem: unknown) => boolean;
  GlobalFree: (hMem: unknown) => unknown;
  RtlMoveMemory: (dest: unknown, src: Buffer, len: number) => void;
  GdiplusStartup: (token: unknown[], input: Buffer, output: null) => number;
  GdiplusShutdown: (token: unknown) => void;
  GdipCreateBitmapFromFile: (path: string, bitmap: unknown[]) => number;
  GdipGetImageWidth: (image: unknown, width: number[]) => number;
  GdipGetImageHeight: (image: unknown, height: number[]) => number;
  GdipCreateHBITMAPFromBitmap: (bitmap: unknown, hbm: unknown[], bg: number) => number;
  GdipDisposeImage: (image: unknown) => number;
  CreateCompatibleDC: (hdc: null) => unknown;
  GetDIBits: (hdc: unknown, hbm: unknown, start: number, lines: number, bits: Buffer | null, bmi: Buffer, usage: number) => number;
  DeleteDC: (hdc: unknown) => boolean;
  DeleteObject: (h: unknown) => boolean;
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
    const gdi32 = koffi.load('gdi32.dll');
    const gdiplus = koffi.load('gdiplus.dll');
    api = {
      OpenClipboard: user32.func('bool OpenClipboard(void* hWnd)'),
      EmptyClipboard: user32.func('bool EmptyClipboard()'),
      SetClipboardData: user32.func('void* SetClipboardData(uint32 uFormat, void* hMem)'),
      CloseClipboard: user32.func('bool CloseClipboard()'),
      RegisterClipboardFormatW: user32.func('uint32 RegisterClipboardFormatW(const char16_t* name)'),
      GlobalAlloc: kernel32.func('void* GlobalAlloc(uint32 uFlags, uintptr dwBytes)'),
      GlobalLock: kernel32.func('void* GlobalLock(void* hMem)'),
      GlobalUnlock: kernel32.func('bool GlobalUnlock(void* hMem)'),
      GlobalFree: kernel32.func('void* GlobalFree(void* hMem)'),
      RtlMoveMemory: kernel32.func('void RtlMoveMemory(void* dest, const void* src, uintptr len)'),
      GdiplusStartup: gdiplus.func('int GdiplusStartup(_Out_ void** token, void* input, void* output)'),
      GdiplusShutdown: gdiplus.func('void GdiplusShutdown(void* token)'),
      GdipCreateBitmapFromFile: gdiplus.func('int GdipCreateBitmapFromFile(const char16_t* filename, _Out_ void** bitmap)'),
      GdipGetImageWidth: gdiplus.func('int GdipGetImageWidth(void* image, _Out_ uint32* width)'),
      GdipGetImageHeight: gdiplus.func('int GdipGetImageHeight(void* image, _Out_ uint32* height)'),
      GdipCreateHBITMAPFromBitmap: gdiplus.func('int GdipCreateHBITMAPFromBitmap(void* bitmap, _Out_ void** hbmReturn, uint32 background)'),
      GdipDisposeImage: gdiplus.func('int GdipDisposeImage(void* image)'),
      CreateCompatibleDC: gdi32.func('void* CreateCompatibleDC(void* hdc)'),
      GetDIBits: gdi32.func('int GetDIBits(void* hdc, void* hbm, uint32 start, uint32 lines, void* bits, void* bmi, uint32 usage)'),
      DeleteDC: gdi32.func('bool DeleteDC(void* hdc)'),
      DeleteObject: gdi32.func('bool DeleteObject(void* hObj)'),
    };
    return api;
  } catch {
    return null;
  }
}

const GMEM_MOVEABLE = 0x0002;
const CF_DIB = 8;
const BITMAPINFOHEADER_SIZE = 40;

function setClipboardData(a: Api, fmt: number, data: Buffer): boolean {
  const hGlobal = a.GlobalAlloc(GMEM_MOVEABLE, data.length);
  if (!hGlobal) return false;
  const ptr = a.GlobalLock(hGlobal);
  if (!ptr) { a.GlobalFree(hGlobal); return false; }
  a.RtlMoveMemory(ptr, data, data.length);
  a.GlobalUnlock(hGlobal);
  const result = a.SetClipboardData(fmt, hGlobal);
  if (!result) a.GlobalFree(hGlobal);
  return !!result;
}

export function copyImageToClipboard(pngPath: string): boolean {
  const a = getApi();
  if (!a) return false;

  const startupInput = Buffer.alloc(24, 0);
  startupInput.writeUInt32LE(1, 0);
  const token: unknown[] = [null];
  if (a.GdiplusStartup(token, startupInput, null) !== 0) return false;

  try {
    const bmp: unknown[] = [null];
    if (a.GdipCreateBitmapFromFile(pngPath, bmp) !== 0) return false;

    try {
      const w = [0], h = [0];
      a.GdipGetImageWidth(bmp[0], w);
      a.GdipGetImageHeight(bmp[0], h);
      if (!w[0] || !h[0]) return false;

      const hbm: unknown[] = [null];
      if (a.GdipCreateHBITMAPFromBitmap(bmp[0], hbm, 0x00FFFFFF) !== 0) return false;

      try {
        const hdc = a.CreateCompatibleDC(null);
        if (!hdc) return false;

        try {
          const stride = w[0] * 4;
          const pixelSize = stride * h[0];

          // BITMAPINFOHEADER
          const bmi = Buffer.alloc(BITMAPINFOHEADER_SIZE, 0);
          bmi.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0); // biSize
          bmi.writeInt32LE(w[0], 4);                    // biWidth
          bmi.writeInt32LE(h[0], 8);                    // biHeight (positive = bottom-up)
          bmi.writeUInt16LE(1, 12);                     // biPlanes
          bmi.writeUInt16LE(32, 14);                    // biBitCount
          bmi.writeUInt32LE(0, 16);                     // biCompression = BI_RGB
          bmi.writeUInt32LE(pixelSize, 20);             // biSizeImage

          const pixels = Buffer.alloc(pixelSize);
          const lines = a.GetDIBits(hdc, hbm[0], 0, h[0], pixels, bmi, 0);
          if (!lines) return false;

          // CF_DIB = BITMAPINFOHEADER + pixel data
          const dib = Buffer.concat([bmi, pixels]);

          if (!a.OpenClipboard(null)) return false;
          a.EmptyClipboard();

          let ok = setClipboardData(a, CF_DIB, dib);

          // Also set raw PNG for modern apps
          const pngFormat = a.RegisterClipboardFormatW('PNG');
          if (pngFormat) {
            setClipboardData(a, pngFormat, fs.readFileSync(pngPath));
          }

          a.CloseClipboard();
          return ok;
        } finally {
          a.DeleteDC(hdc);
        }
      } finally {
        a.DeleteObject(hbm[0]);
      }
    } finally {
      a.GdipDisposeImage(bmp[0]);
    }
  } finally {
    a.GdiplusShutdown(token[0]);
  }
}
