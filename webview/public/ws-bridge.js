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
  //   opts.acceptMessage(data)         -> boolean      : optional server-frame filter
  //   opts.isVisible()                 -> boolean      : optional host visibility override
  // Close codes the server uses for a close it does NOT want the bridge to silently
  // retry (an ordinary drop - network blip, daemon restart - keeps the normal backoff
  // loop). Deliberate disconnects and hidden idle clients stay down:
  //  - CLOSED_BY_PEER (4001): another panel's Connected Clients list disconnected this
  //    one on purpose. Reconnecting on its own would hand the connection straight back
  //    and make that button look like a no-op, so only a manual Reconnect click (or the
  //    same bargain chat.html strikes for "Stop daemon" via its own userStopped flag)
  //    brings it back.
  //  - CLOSED_IDLE (4002): the server closed it for sitting unused too long. Retrying it
  //    while hidden would waste resources. Visible clients retry automatically;
  //    hidden clients recover when viewed again or manually reconnected.
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
    var HEALTH_INTERVAL = 10000, HEALTH_TIMEOUT = 10000;
    // stoppedReason is null for an ordinary drop the backoff loop is already retrying,
    // and 'peer' | 'idle' for the two closes above - kept separate from the dispatched
    // status so callers that only care "is this a close that needs a way back" can still
    // treat it as a boolean while reconnectIfIdle and the visibility listener need to
    // know which one it was.
    var ws, queue = [], ready = false, attempt = 0, reconnectTimer, stoppedReason = null;
    var conversationId, workspaceRoute;
    var healthTimer;
    var connectionUrl, generation = 0, sequence = 0, watchRead, targets = new Set();
    function requestId() { return 'detail-' + generation + '-' + (++sequence); }
    function invalidateTargets() {
      generation++;
      targets.forEach(function (handle) { handle.close(); });
      if (watchRead) { clearTimeout(watchRead.timer); watchRead.reject(new Error('Disconnected')); watchRead.drain(); watchRead = null; }
    }
    // This lane is never queued and consumes its own replies before conversation dispatch.
    function watch(target, since, current) {
      if (current && !current()) return Promise.reject(new Error('Observation retired'));
      if (!ready || !connectionUrl) return Promise.reject(new Error('Disconnected'));
      if (watchRead) return watchRead.drained.then(function () { return watch(target, since, current); });
      return new Promise(function (resolve, reject) {
        var id = requestId();
        watchRead = { id: id, resolve: resolve, reject: reject, timer: setTimeout(function () {
          // Retain the intercept until this read drains or the main socket closes.
          if (watchRead && watchRead.id === id) watchRead.reject(new Error('Observation timed out'));
        }, 5000) };
        watchRead.drained = new Promise(function (done) { watchRead.drain = done; });
        ws.send(JSON.stringify({ type: 'watchSession', requestId: id, sessionId: target.sessionId, since: since, wait: 2, full: true }));
      });
    }
    function openTarget(target, observe, closed, signal) {
      if (!ready || !connectionUrl) return Promise.reject(new Error('Disconnected'));
      var identity = { sessionId: target.sessionId, workspace: target.workspace, providerId: target.providerId };
      var url = new URL(connectionUrl), epoch = generation;
      ['panel', 'fresh', 'session'].forEach(function (key) { url.searchParams.delete(key); });
      url.searchParams.set('session', identity.sessionId); url.searchParams.set('dir', identity.workspace);
      url.searchParams.set('provider', identity.providerId); url.searchParams.set('purpose', 'dashboard-target');
      return new Promise(function (resolve, reject) {
        var socket = new WebSocket(url.toString()), pending = new Map(), ended = false, accepted = false, effectPending = false, attachedWorkspace;
        var timer = setTimeout(function () { handle.close(); }, 5000);
        function request(message, effect) {
          if (ended || !accepted || epoch !== generation || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Inspect target again'));
          if (effect && effectPending) return Promise.reject(new Error('Request pending'));
          var id = requestId(); if (effect) effectPending = true;
          return new Promise(function (done, fail) {
            pending.set(id, { effect: effect, resolve: done, reject: fail, timer: setTimeout(function () {
              pending.delete(id); if (effect) effectPending = false;
              fail(new Error(effect ? 'Outcome unknown; inspect before another action' : 'Inspection timed out'));
            }, effect ? 10000 : 5000) });
            try { socket.send(JSON.stringify(Object.assign({}, message, { requestId: id, expectedSessionId: identity.sessionId, expectedWorkspace: identity.workspace }))); }
            catch (error) { handle.close(); }
          });
        }
        var handle = {
          inspect: function () { return request({ type: 'getSessionControl' }, false).then(function (data) {
            if (data.sessionId !== identity.sessionId || data.workspace !== attachedWorkspace || !data.selection || data.selection.providerId !== identity.providerId) { handle.close(); throw new Error('Target identity changed'); }
            return Object.assign({}, data, { target: Object.assign({}, identity) });
          }); },
          effect: function (kind, payload) {
            if (['answer', 'async-answer', 'steer', 'stop'].indexOf(kind) < 0) return Promise.reject(new Error('Unsupported action'));
            var message = kind === 'answer' ? { type: 'providerResponse', id: payload.id, response: payload.response }
              : kind === 'async-answer' ? { type: 'send', text: payload.text, expectedInteractionId: payload.id, mode: payload.mode }
              : kind === 'steer' ? { type: 'steer', text: payload.text } : { type: 'stop' };
            return request(message, true);
          },
          close: function () {
            if (ended) return; ended = true; clearTimeout(timer); targets.delete(handle);
            if (signal) signal.removeEventListener('abort', handle.close);
            pending.forEach(function (p) { clearTimeout(p.timer); p.reject(new Error(p.effect ? 'Outcome unknown; inspect before another action' : 'Disconnected')); }); pending.clear();
            socket.close(); reject(new Error('Target unavailable')); if (closed) closed();
          }
        };
        targets.add(handle);
        if (signal) { if (signal.aborted) handle.close(); else signal.addEventListener('abort', handle.close, { once: true }); }
        socket.onclose = socket.onerror = handle.close;
        socket.onmessage = function (event) {
          if (ended || epoch !== generation) return;
          var data; try { data = JSON.parse(event.data); } catch (e) { handle.close(); return; }
          if (data.type === 'targetReady') {
            if (data.sessionId !== identity.sessionId || data.providerId !== identity.providerId || typeof data.workspace !== 'string' || !data.workspace) { handle.close(); return; }
            attachedWorkspace = data.workspace; accepted = true; clearTimeout(timer); resolve(handle); return;
          }
          if (!accepted) return;
          var item = pending.get(data.requestId);
          if (item && ((!item.effect && data.type === 'sessionControl') || data.type === 'providerResponseAccepted' || data.type === 'providerNotice' && data.error)) {
            clearTimeout(item.timer); pending.delete(data.requestId); if (item.effect) effectPending = false;
            if (data.error) item.reject(new Error(data.message || 'Request refused')); else item.resolve(data);
          } else if (observe) observe(data);
        };
      });
    }
    window.argusAgents = { open: openTarget, watch: watch };

    function watchHealth() {
      clearTimeout(healthTimer);
      healthTimer = setTimeout(function () {
        if (!ready) return;
        // This existing, inexpensive request is answered directly on this socket
        // and does not refresh the session's idle clock or call a provider API.
        ws.send(JSON.stringify({ type: 'getBgTasks' }));
        healthTimer = setTimeout(function () {
          if (!ready) return;
          ready = false;
          ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
          try { ws.close(); } catch (e) {}
          setStatus(false);
          scheduleReconnect();
        }, HEALTH_TIMEOUT);
      }, HEALTH_INTERVAL);
    }

    function dispatch(data) {
      window.dispatchEvent(new MessageEvent('message', { data: data }));
    }

    function setStatus(connected, closeReason) {
      if (!connected) invalidateTargets();
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

    function isVisible() {
      return opts.isVisible ? opts.isVisible() : !document.hidden;
    }

    function connect() {
      if (stoppedReason === 'idle' && !isVisible()) return;
      ready = false;
      invalidateTargets();
      clearTimeout(healthTimer);
      dispatch({ type: 'ws_status', connected: false });
      if (ws) {
        ws.onopen = ws.onclose = ws.onmessage = ws.onerror = null;
        try { ws.close(); } catch (e) {}
      }
      var url = opts.nextUrl();
      if (!url) { setStatus(false); scheduleReconnect(); return; }
      // Panel ownership is held in daemon memory. Carry the displayed conversation
      // across reconnects so a restarted daemon cannot silently start a new thread.
      var target = new URL(url);
      var route = target.searchParams.get('dir') || '';
      if (workspaceRoute !== undefined && workspaceRoute !== route) conversationId = undefined;
      workspaceRoute = route;
      if (conversationId) target.searchParams.set('session', conversationId);
      else if (conversationId === null) target.searchParams.delete('session');
      url = target.toString();
      connectionUrl = url;
      ws = new WebSocket(url);

      ws.onopen = function () {
        ready = true;
        stoppedReason = null;
        attempt = 0;
        watchHealth();
        setStatus(true);
        // React is already mounted on a reconnect. Ask for missed history/live
        // output before flushing any user input queued during the disconnect.
        if (conversationId) ws.send(JSON.stringify({ type: 'webviewReady' }));
        queue.splice(0).forEach(function (m) { ws.send(JSON.stringify(m)); });
      };
      ws.onmessage = function (event) {
        if (ready) watchHealth();
        var data = JSON.parse(event.data);
        if (watchRead && data.type === 'sessionEvents' && data.requestId === watchRead.id) {
          var read = watchRead; watchRead = null; clearTimeout(read.timer); read.drain(); read.resolve(data); return;
        }
        if (!opts.acceptMessage || opts.acceptMessage(data)) {
          if ((data.type === 'sessionId' || data.type === 'sessionLoaded') && typeof data.id === 'string') conversationId = data.id;
          else if (data.type === 'clear') conversationId = null;
          dispatch(data);
        }
      };
      ws.onerror = function (e) { ready = false; clearTimeout(healthTimer); setStatus(false); console.error('[argus-ws] error', e); };
      ws.onclose = function (ev) {
        ready = false;
        clearTimeout(healthTimer);
        var code = ev && ev.code;
        if (code === CLOSED_BY_PEER || code === CLOSED_IDLE) {
          stoppedReason = code === CLOSED_IDLE ? 'idle' : 'peer';
          console.warn('[argus-ws] ' + (stoppedReason === 'idle' ? 'closed for being idle' : 'disconnected from another panel') + ' - staying down until ' + (stoppedReason === 'idle' ? 'viewed again or Reconnect' : 'Reconnect'));
          setStatus(false, stoppedReason);
          if (stoppedReason === 'idle' && isVisible()) scheduleReconnect();
          return;
        }
        setStatus(false, null);
        scheduleReconnect();
      };
    }

    function post(msg) {
      if (msg && (msg.type === 'newSession' || msg.type === 'send' && typeof msg.text === 'string' && msg.text.trim() === '/clear')) conversationId = null;
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
      if (!isVisible() || ready) return;
      if (!stoppedReason || stoppedReason === 'idle') reconnectNow();
    });

    window.argusConnectionState = function () { return { connected: ready, closeReason: stoppedReason || undefined }; };
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
