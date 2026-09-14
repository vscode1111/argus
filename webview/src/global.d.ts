// Published by webview/public/ws-bridge.js (a classic script that runs before the React
// bundle) so the app can offer a way back from a disconnect that is deliberately not
// retried - see the CLOSED_BY_PEER close code. Optional at the type level because the
// mock e2e harness renders the app without that script.
interface Window {
  argusReconnect?: () => void;
  /** Published by the browser host shims; absent in the VS Code webview, which is
   *  always a local peer and therefore never asked to log in. */
  argusLogin?: (user: string, password: string) => Promise<{ ok: boolean; status?: number; error?: string; retryAfterMs?: number }>;
  /** Whether the server already refused this peer for want of a login, asked once on
   *  mount because the event that carries it fires before React is listening. */
  argusAuthRequired?: () => boolean;
}
