// Shared WebSocket bridge factory for all three Argus webview hosts: the VS Code
// webview (media/chat.html), the daemon-served browser page (media/browser.html),
// and the Vite dev server (webview/index.html). Each host supplies only what
// differs - how to resolve the next WS URL (nextUrl) and how to route outgoing
// messages - while the reconnect / queue / dispatch machinery lives here once.
//
// Source of truth: webview/public/ws-bridge.js. The dev server serves it from
// /public; `vite build` copies it to media/ (publicDir) so the extension webview
// and the daemon's HTTP server can load the very same file. Classic (non-module)
// script so it runs before the React bundle, which calls acquireVsCodeApi on mount.
(function () {
  // createArgusBridge(opts) -> { post(msg), reconnectNow(), isReady() }
  //   opts.nextUrl()            -> string|null : URL for the next connection attempt
  //                                              (null = nothing to connect to yet)
  //   opts.onStatus(connected)  -> void         : optional, fired on connect/disconnect
  window.createArgusBridge = function createArgusBridge(opts) {
    var DELAYS = [1000, 2000, 4000, 8000, 10000];
    var ws, queue = [], ready = false, attempt = 0, reconnectTimer;

    function dispatch(data) {
      window.dispatchEvent(new MessageEvent('message', { data: data }));
    }

    function setStatus(connected) {
      dispatch({ type: 'ws_status', connected: connected });
      if (opts.onStatus) opts.onStatus(connected);
    }

    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      var delay = DELAYS[Math.min(attempt, DELAYS.length - 1)];
      attempt++;
      console.warn('[argus-ws] reconnecting in ' + delay + 'ms (attempt ' + attempt + ')');
      reconnectTimer = setTimeout(connect, delay);
    }

    function connect() {
      ready = false;
      if (ws) {
        ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
        try { ws.close(); } catch (e) {}
      }
      var url = opts.nextUrl();
      if (!url) { setStatus(false); scheduleReconnect(); return; }
      ws = new WebSocket(url);

      ws.onopen = function () {
        ready = true;
        attempt = 0;
        setStatus(true);
        queue.splice(0).forEach(function (m) { ws.send(JSON.stringify(m)); });
      };
      ws.onmessage = function (event) { dispatch(JSON.parse(event.data)); };
      ws.onerror = function (e) { console.error('[argus-ws] error', e); };
      ws.onclose = function () { ready = false; setStatus(false); scheduleReconnect(); };
    }

    function post(msg) {
      if (ready) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    }

    function reconnectNow() {
      clearTimeout(reconnectTimer);
      attempt = 0;
      connect();
    }

    // Reconnect when the tab becomes visible again (catches sleep/resume).
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !ready) reconnectNow();
    });

    connect();
    return { post: post, reconnectNow: reconnectNow, isReady: function () { return ready; } };
  };
})();
