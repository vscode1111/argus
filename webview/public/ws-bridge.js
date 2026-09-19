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
  // createArgusBridge(opts) -> { post(msg), reconnectNow(), reconnectIfIdle(), isReady() }
  //   opts.nextUrl()                    -> string|null : URL for the next connection
  //                                                       attempt (null = nothing yet)
  //   opts.onStatus(connected, reason)  -> void         : optional, fired on
  //                                                        connect/disconnect; reason is
  //                                                        'peer' | 'idle' | undefined
  // Close codes the server uses for a close it does NOT want the bridge to silently
  // retry (an ordinary drop - network blip, daemon restart - keeps the normal backoff
  // loop). Both stay down until something explicit brings them back, but they differ in
  // what counts as "explicit":
  //  - CLOSED_BY_PEER (4001): another panel's Connected Clients list disconnected this
  //    one on purpose. Reconnecting on its own would hand the connection straight back
  //    and make that button look like a no-op, so only a manual Reconnect click (or the
  //    same bargain chat.html strikes for "Stop daemon" via its own userStopped flag)
  //    brings it back.
  //  - CLOSED_IDLE (4002): the server closed it for sitting unused too long. Retrying it
  //    blindly on the usual timer would just get it closed again next sweep (rejoining
  //    does not touch the server's idle clock), so it still needs to stay down while
  //    nobody is looking - but unlike a peer close, "the panel/tab is looked at again" is
  //    itself a legitimate, automatic way back, on top of the same manual click.
  var CLOSED_BY_PEER = 4001;
  var CLOSED_IDLE = 4002;

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
    // stoppedReason is null for an ordinary drop the backoff loop is already retrying,
    // and 'peer' | 'idle' for the two closes above - kept separate from the dispatched
    // status so callers that only care "is this a close that needs a way back" can still
    // treat it as a boolean while reconnectIfIdle and the visibility listener need to
    // know which one it was.
    var ws, queue = [], ready = false, attempt = 0, reconnectTimer, stoppedReason = null;

    function dispatch(data) {
      window.dispatchEvent(new MessageEvent('message', { data: data }));
    }

    function setStatus(connected, closeReason) {
      dispatch({ type: 'ws_status', connected: connected, closeReason: closeReason || undefined });
      if (opts.onStatus) opts.onStatus(connected, closeReason);
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
        var code = ev && ev.code;
        if (code === CLOSED_BY_PEER || code === CLOSED_IDLE) {
          stoppedReason = code === CLOSED_IDLE ? 'idle' : 'peer';
          console.warn('[argus-ws] ' + (stoppedReason === 'idle' ? 'closed for being idle' : 'disconnected from another panel') + ' - staying down until ' + (stoppedReason === 'idle' ? 'viewed again or Reconnect' : 'Reconnect'));
          setStatus(false, stoppedReason);
          return;
        }
        setStatus(false, null);
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
      stoppedReason = null;   // an explicit reconnect is the way back from either close
      connect();
    }

    // The automatic way back from an idle close only: a peer close stays down until the
    // explicit manual click, since silently resurrecting a deliberate disconnect just
    // because the panel came back into view would undo the very thing that was asked for.
    function reconnectIfIdle() {
      if (stoppedReason === 'idle') reconnectNow();
    }

    // Reconnect when the tab becomes visible again (catches sleep/resume, and now also
    // an idle close) - but not after a peer close, or merely switching tabs would undo it.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || ready) return;
      if (!stoppedReason || stoppedReason === 'idle') reconnectNow();
    });

    connect();
    // The React app offers the way back (the connection dot turns into a Reconnect
    // button), and it is the same bridge in all three hosts, so it is published here
    // rather than routed through each host's own message shim. reconnectIfIdle is NOT
    // published globally - it is only ever triggered by a host's own visibility signal
    // (chat.html's panelVisible message, or the visibilitychange listener above for the
    // two browser-tab hosts), never by the React app, which always wants the
    // unconditional manual override.
    window.argusReconnect = reconnectNow;
    return { post: post, reconnectNow: reconnectNow, reconnectIfIdle: reconnectIfIdle, isReady: function () { return ready; } };
  };
})();
