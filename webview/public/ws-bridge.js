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
  // Close code the server uses when a panel disconnects this client on purpose (the
  // Settings "Connected clients" list). Reconnecting would hand the connection straight
  // back and make that button look like a no-op, so this one close is terminal until
  // the user asks for it back - the same bargain chat.html already strikes for
  // "Stop daemon" via its own userStopped flag.
  var CLOSED_BY_PEER = 4001;

  // Remote-access auth: token storage, the login POST, and the `auth_required` signal
  // the React app renders its login screen from. It lives here, beside the bridge, for
  // the same reason the reconnect machinery does - the dev shim and the daemon-served
  // page would otherwise carry two copies of it and drift.
  //
  // The token is kept in localStorage and sent explicitly (query param), not as a
  // cookie: the dev page is served from Vite on another port, so a cookie would drag in
  // CORS-with-credentials, and a browser cannot set headers on a WebSocket handshake
  // anyway - the URL is the only channel that works for both.
  window.createArgusAuth = function createArgusAuth(httpBase) {
    var KEY = 'argus.authToken';
    var required = false;

    function token() {
      try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
    }
    function setToken(value) {
      try { value ? localStorage.setItem(KEY, value) : localStorage.removeItem(KEY); } catch (e) {}
    }
    function setRequired(flag) {
      if (required === flag) return;
      required = flag;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'auth_required', required: flag } }));
    }
    // The first connect attempt runs while the React bundle is still evaluating, so the
    // event above is dispatched before App has a message listener and is simply lost -
    // and the dedupe means it never fires again. The app therefore reads the state once
    // on mount through this, exactly as the deep-link replay defers to webviewReady.
    window.argusAuthRequired = function () { return required; };
    function login(user, password) {
      return fetch(httpBase + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: user, password: password })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (res.ok && body.token) { setToken(body.token); setRequired(false); return { ok: true }; }
          return { ok: false, status: res.status, error: body.error || 'login failed', retryAfterMs: body.retryAfterMs };
        });
      }).catch(function (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      });
    }

    return { token: token, setToken: setToken, login: login, setRequired: setRequired };
  };

  window.createArgusBridge = function createArgusBridge(opts) {
    var DELAYS = [1000, 2000, 4000, 8000, 10000];
    var ws, queue = [], ready = false, attempt = 0, reconnectTimer, stopped = false;

    function dispatch(data) {
      window.dispatchEvent(new MessageEvent('message', { data: data }));
    }

    function setStatus(connected, closedByPeer) {
      dispatch({ type: 'ws_status', connected: connected, closedByPeer: !!closedByPeer });
      if (opts.onStatus) opts.onStatus(connected, !!closedByPeer);
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
      ws.onclose = function (ev) {
        ready = false;
        if (ev && ev.code === CLOSED_BY_PEER) {
          console.warn('[argus-ws] disconnected from another panel - staying down until Reconnect');
          stopped = true;
          setStatus(false, true);
          return;
        }
        setStatus(false, false);
        scheduleReconnect();
      };
    }

    function post(msg) {
      if (ready) ws.send(JSON.stringify(msg));
      else queue.push(msg);
    }

    function reconnectNow() {
      clearTimeout(reconnectTimer);
      attempt = 0;
      stopped = false;   // an explicit reconnect is the way back from a peer close
      connect();
    }

    // Reconnect when the tab becomes visible again (catches sleep/resume) - but not
    // after a peer close, or merely switching tabs would undo it.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !ready && !stopped) reconnectNow();
    });

    connect();
    // The React app offers the way back (the connection dot turns into a Reconnect
    // button), and it is the same bridge in all three hosts, so it is published here
    // rather than routed through each host's own message shim.
    window.argusReconnect = reconnectNow;
    return { post: post, reconnectNow: reconnectNow, isReady: function () { return ready; } };
  };
})();
