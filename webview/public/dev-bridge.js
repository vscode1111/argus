// Bridge to the argus-agent WebSocket plugin running inside the Vite dev server.
// Loaded as a classic (non-module) script from /public so it runs synchronously
// before the deferred React entry (/src/index.dev.tsx), which calls
// acquireVsCodeApi() on mount. Dev-only; the VS Code webview uses chat.html.
window.acquireVsCodeApi = () => {
  const _params = new URLSearchParams(window.location.search);
  let _dir = _params.get('dir');
  let _nonce = _params.get('nonce');
  let _wsUrl = null;

  // E2e mock isolation: when ?mock=1, do not forward these data-query messages
  // to the live dev backend. Their async replies (the dev machine's real
  // skills/sessions) would otherwise clobber the data that mock tests inject
  // via window.dispatchEvent. readFilePreview/copyImage/getAccountUsage are
  // intentionally NOT suppressed: the image-preview mock tests need a real WS
  // roundtrip, and the account-usage mock test waits for the real reply before
  // injecting.
  const _mock = _params.get('mock') === '1';
  const _MOCK_SUPPRESSED = new Set(['getSkills', 'listSessions']);

  // Derive the backend host from the page so LAN devices (e.g. a phone on
  // the same WiFi) reach the dev machine instead of their own localhost.
  const _host = window.location.hostname || 'localhost';

  function buildWsUrl() {
    const p = new URLSearchParams();
    if (_nonce) p.set('nonce', _nonce);
    if (_dir) p.set('dir', _dir);
    _wsUrl = 'ws://' + _host + ':3001/agent?' + p.toString();
  }

  // Pull the current nonce from the dev server. It rotates on every server
  // restart, so refreshing it before each (re)connect lets an already-open tab
  // recover on its own after a restart or a Network-settings change - no manual
  // reload. Best-effort: if the server is down the XHR fails fast (connection
  // refused on localhost) and we keep the last nonce and retry.
  function refreshNonce() {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://' + _host + ':3001/nonce', false);
      xhr.send();
      if (xhr.status === 200 && xhr.responseText) _nonce = xhr.responseText;
    } catch (e) {}
  }

  let ws;
  const queue = [];
  let ready = false;
  let reconnectTimer;
  let attempt = 0;
  const DELAYS = [1000, 2000, 4000, 8000, 10000];

  function dispatch(data) {
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const delay = DELAYS[Math.min(attempt, DELAYS.length - 1)];
    attempt++;
    console.warn(`[argus-ws] reconnecting in ${delay}ms (attempt ${attempt})`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    ready = false;
    if (ws) {
      ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
      try { ws.close(); } catch(e) {}
    }
    refreshNonce();
    buildWsUrl();
    ws = new WebSocket(_wsUrl);

    ws.onopen = () => {
      ready = true;
      attempt = 0;
      dispatch({ type: 'ws_status', connected: true });
      queue.splice(0).forEach(m => ws.send(JSON.stringify(m)));
    };

    ws.onmessage = (event) => {
      dispatch(JSON.parse(event.data));
    };

    ws.onerror = (e) => console.error('[argus-ws] error', e);

    ws.onclose = () => {
      ready = false;
      dispatch({ type: 'ws_status', connected: false });
      scheduleReconnect();
    };
  }

  connect();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !ready) {
      clearTimeout(reconnectTimer);
      attempt = 0;
      connect();
    }
  });

  // Switch workspace in place: repoint the dir query param and reconnect.
  function switchWorkspace(dir) {
    _dir = dir;
    buildWsUrl();
    clearTimeout(reconnectTimer);
    attempt = 0;
    connect();
  }

  return {
    postMessage: (msg) => {
      if (msg && msg.type === 'switchWorkspace') {
        switchWorkspace(msg.dir);
        return;
      }
      if (_mock && msg && _MOCK_SUPPRESSED.has(msg.type)) {
        console.log('[mock] suppressed', msg.type);
        return;
      }
      console.log('[-> agent]', msg);
      if (ready) {
        ws.send(JSON.stringify(msg));
      } else {
        queue.push(msg);
      }
    },
  };
};
