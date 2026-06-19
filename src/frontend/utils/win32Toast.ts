import koffi from 'koffi';

// Fires a real Windows OS toast (Action Center) fully in-process via koffi,
// driving the WinRT ToastNotification COM API directly (no PowerShell / no
// subprocess). VS Code's `showInformationMessage` only shows inside the VS Code
// window; this surfaces a system notification even when VS Code isn't focused.
//
// We register a lightweight AppUserModelId under HKCU so the toast is attributed
// to "Argus" (no admin, no Start Menu shortcut). Title/body are XML-escaped, so
// user text can't break the toast XML.
//
// Click-to-focus uses protocol activation: when a `launchUri` is given, the toast
// carries `activationType='protocol' launch='<uri>'`, so clicking it makes Windows
// ShellExecute the URI (e.g. `vscode://local.argus/focus`). That route needs no
// COM activator and, crucially, no cross-thread callback into Node - WinRT fires
// the in-process Activated event on a thread-pool thread, which a koffi JS callback
// can't service safely.

const APP_ID = 'Argus.Chat';
const APP_NAME = 'Argus';
// A stub activator CLSID is required for a COM-server-less app's protocol-activation
// toasts to stay activatable in the Action Center. We never back it with a COM server
// (protocol activation is dispatched by the shell, not the activator), so any fixed
// GUID works; non-protocol activation types would break, but we only use protocol.
const ACTIVATOR_CLSID = '{8f2b6d41-1c7a-4e93-9a6f-2d5b0e3c4a18}';

// WinRT IInspectable occupies vtable slots 0..5; runtime-class methods follow.
const IDX_QueryInterface = 0;
const IDX_LoadXml = 6;
const IDX_CreateToastNotification = 6;
const IDX_Show = 6;
const IDX_CreateToastNotifierWithId = 7;

const HKEY_CURRENT_USER = 0xffffffff80000001n;
const REG_SZ = 1;

type Api = {
  RoInitialize: (n: number) => number;
  WindowsCreateString: (src: string, len: number, out: unknown) => number;
  RoGetActivationFactory: (classId: unknown, iid: unknown, out: unknown) => number;
  RoActivateInstance: (classId: unknown, out: unknown) => number;
  RegSetKeyValueW: (hKey: bigint, sub: string, name: string, type: number, data: Buffer, cb: number) => number;
  P_QI: unknown;
  P_CreateNotifier: unknown;
  P_LoadXml: unknown;
  P_CreateToast: unknown;
  P_Show: unknown;
};

let initialized = false;
let api: Api | null = null;
let roInitialized = false;
let aumidRegistered = false;

function getApi(): Api | null {
  if (initialized) return api;
  initialized = true;
  if (process.platform !== 'win32') return null;
  try {
    const combase = koffi.load('combase.dll');
    const advapi32 = koffi.load('advapi32.dll');
    api = {
      RoInitialize: combase.func('long RoInitialize(uint32 initType)'),
      WindowsCreateString: combase.func('long WindowsCreateString(str16 src, uint32 len, void* out)'),
      RoGetActivationFactory: combase.func('long RoGetActivationFactory(void* classId, void* iid, void* out)'),
      RoActivateInstance: combase.func('long RoActivateInstance(void* classId, void* out)'),
      RegSetKeyValueW: advapi32.func('long RegSetKeyValueW(void* hKey, str16 subKey, str16 valueName, uint32 type, void* data, uint32 cb)'),
      P_QI: koffi.proto('long ToastQI(void* self, void* iid, void* out)'),
      P_CreateNotifier: koffi.proto('long ToastCreateNotifier(void* self, void* appId, void* out)'),
      P_LoadXml: koffi.proto('long ToastLoadXml(void* self, void* xml)'),
      P_CreateToast: koffi.proto('long ToastCreate(void* self, void* xmlDoc, void* out)'),
      P_Show: koffi.proto('long ToastShow(void* self, void* toast)'),
    };
  } catch {
    api = null;
  }
  return api;
}

function iidBuf(guid: string): Buffer {
  const h = guid.replace(/-/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

const IID_IToastNotificationManagerStatics = iidBuf('50AC103F-D235-4598-BBEF-98FE4D1A3AD4');
const IID_IXmlDocumentIO = iidBuf('6CD0E74E-EE65-4489-9EBF-CA43E87BA637');
const IID_IXmlDocument = iidBuf('F7F3A506-1E87-42D6-BCFB-B8C809FA5494');
const IID_IToastNotificationFactory = iidBuf('04124B20-82C6-4229-B109-FD9ED4662B53');

function xmlEscape(s: string): string {
  return String(s).replace(/[<>&'"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string
  ));
}

function check(name: string, hr: number): void {
  if (hr < 0) throw new Error(`${name} failed: 0x${(hr >>> 0).toString(16)}`);
}

function hstr(a: Api, s: string): unknown {
  const holder = koffi.alloc('void *', 1);
  check('WindowsCreateString', a.WindowsCreateString(s, s.length, holder));
  return koffi.decode(holder, 'void *');
}

function vcall(obj: unknown, index: number, proto: unknown, ...args: unknown[]): number {
  const vtbl = koffi.decode(obj, 'void *');
  const method = koffi.decode(vtbl, index * 8, 'void *');
  return koffi.call(method, proto as never, obj, ...args) as number;
}

function activate(a: Api, classId: string, iid: Buffer): unknown {
  const holder = koffi.alloc('void *', 1);
  check('RoGetActivationFactory', a.RoGetActivationFactory(hstr(a, classId), iid, holder));
  return koffi.decode(holder, 'void *');
}

function registerAumid(a: Api): void {
  if (aumidRegistered) return;
  const key = `Software\\Classes\\AppUserModelId\\${APP_ID}`;
  const name = Buffer.from(`${APP_NAME}\0`, 'utf16le');
  a.RegSetKeyValueW(HKEY_CURRENT_USER, key, 'DisplayName', REG_SZ, name, name.length);
  // Stub activator so protocol-activation toasts remain clickable from the Action Center.
  const clsid = Buffer.from(`${ACTIVATOR_CLSID}\0`, 'utf16le');
  a.RegSetKeyValueW(HKEY_CURRENT_USER, key, 'CustomActivator', REG_SZ, clsid, clsid.length);
  aumidRegistered = true;
}

/**
 * Shows a real OS toast. When `launchUri` is set, clicking the toast activates that
 * URI via the shell (protocol activation), e.g. a `vscode://` URI that focuses VS Code.
 * Returns true if the toast was shown, false if unavailable/failed (caller can fall back).
 */
export function showWindowsToast(title: string, body: string, log?: (text: string) => void, launchUri?: string): boolean {
  const a = getApi();
  if (!a) return false;
  try {
    registerAumid(a);
    if (!roInitialized) { a.RoInitialize(1); roInitialized = true; } // ignore S_FALSE / RPC_E_CHANGED_MODE

    // 1. XmlDocument instance -> IXmlDocumentIO.LoadXml
    const xmlHolder = koffi.alloc('void *', 1);
    check('RoActivateInstance', a.RoActivateInstance(hstr(a, 'Windows.Data.Xml.Dom.XmlDocument'), xmlHolder));
    const inspect = koffi.decode(xmlHolder, 'void *');

    const ioHolder = koffi.alloc('void *', 1);
    check('QI IXmlDocumentIO', vcall(inspect, IDX_QueryInterface, a.P_QI, IID_IXmlDocumentIO, ioHolder));
    const xmlIO = koffi.decode(ioHolder, 'void *');

    const launchAttr = launchUri ? ` activationType='protocol' launch='${xmlEscape(launchUri)}'` : '';
    const xml = `<toast${launchAttr}><visual><binding template='ToastGeneric'><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
    check('LoadXml', vcall(xmlIO, IDX_LoadXml, a.P_LoadXml, hstr(a, xml)));

    const docHolder = koffi.alloc('void *', 1);
    check('QI IXmlDocument', vcall(inspect, IDX_QueryInterface, a.P_QI, IID_IXmlDocument, docHolder));
    const xmlDoc = koffi.decode(docHolder, 'void *');

    // 2. ToastNotification factory -> CreateToastNotification(xmlDoc)
    const toastFactory = activate(a, 'Windows.UI.Notifications.ToastNotification', IID_IToastNotificationFactory);
    const toastHolder = koffi.alloc('void *', 1);
    check('CreateToastNotification', vcall(toastFactory, IDX_CreateToastNotification, a.P_CreateToast, xmlDoc, toastHolder));
    const toast = koffi.decode(toastHolder, 'void *');

    // 3. ToastNotificationManager statics -> CreateToastNotifierWithId(appId).Show(toast)
    const mgr = activate(a, 'Windows.UI.Notifications.ToastNotificationManager', IID_IToastNotificationManagerStatics);
    const notifierHolder = koffi.alloc('void *', 1);
    check('CreateToastNotifierWithId', vcall(mgr, IDX_CreateToastNotifierWithId, a.P_CreateNotifier, hstr(a, APP_ID), notifierHolder));
    const notifier = koffi.decode(notifierHolder, 'void *');

    check('Show', vcall(notifier, IDX_Show, a.P_Show, toast));
    return true;
  } catch (e) {
    log?.(`win32Toast: ${(e as Error).message}`);
    return false;
  }
}
