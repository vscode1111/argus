# remote-access-auth: a login and password before anything off this machine can connect

## Goal

Close security-audit issue #3 ("No authentication on WebSocket"). A client that is not on
this machine must sign in; loopback and the VS Code webview stay untouched.

## Acceptance criteria

Each was walked by hand through the real UI against an isolated daemon on :3096, with a
browser tab on `http://192.168.0.136:3096/` as a genuinely non-local peer.

| # | Criterion | Evidence |
|---|---|---|
| 1 | No password -> remote refused | `remote /nonce: 401`, WS `refused 401`, log line `refused unauthenticated remote client 192.168.0.136` |
| 2 | No password -> local untouched | `local /nonce: 200`, local WS `open`, local tab rendered the chat throughout |
| 3 | Password set -> remote sees a login screen | screenshot; `{login:true, chat:false}` remote vs `{login:false, chat:true}` local |
| 4 | Right credentials -> in | login screen gone, chat visible, ws dot `Connected`; row `Browser Windows 192.168.0.136 remote` in Connected clients |
| 5 | Wrong credentials -> refused + lockout | UI showed `invalid credentials`, password field cleared; 6th attempt `429 (retry in 30s)`, and the **correct** password also `429` while locked |
| 6 | Restart ends sessions | sessions are a module-level Map, never written to disk (`resetAuthState` in the spec proves the same path) |
| 7 | Password change revokes live clients | remote tab fell back to the login screen, chat gone, local tab unaffected |
| 8 | No-Origin script refused | `remote WS, no Origin header -> refused 401` (this is the hole the probe found) |
| 9 | Only a salted hash is stored | `contains plaintext password? no`; fields `user, salt, hash, updatedAt` |

## Out of scope

- **TLS.** Password and token cross the LAN in the clear; this stops casual access, not a
  network attacker. Said so on the login screen itself.
- Multiple users, roles, 2FA, password recovery (lose it -> delete the file).
- Persistent sessions (chosen: in-memory), persistent lockout state.
- `POST /logout` for one device - "Sign out all devices" covers revocation.
- Audit issues #4 (`?dir=` sanitisation), #5 (CSP), #8 (`openUrl`).

## Prior art

- `!notes/security-audit.md` #3 had a drafted design: a pre-shared token in
  `~/.claude/argus-token`, constant-time compare, rate limiting. **Reused**: the rate
  limiting, the constant-time requirement, the 600-mode file beside `argus.json`.
  **Departed**: a login form instead of a static token, because a token has to be
  transcribed onto a phone and cannot be changed without editing files.
- `allowNetworkAccess` / `enforceOrigins()` is the code neighbour: config -> gate ->
  Network tab -> live sockets dropped on change. `enforceAuth()` is the same shape.
- `isLocalAddress()` came free from the connected-clients work of the same session.

## Design

- **The gate keys off the peer address, never the Origin.** Origin is client-supplied;
  a request that omits it was treated as local *from anywhere*. Consequence: opening
  `http://192.168.0.136:5173` on this very machine counts as remote and asks for a login.
- `/nonce` is the choke point: a remote peer needs a session token to get one, and the WS
  upgrade then re-checks the token. Static assets stay public so the login screen can
  render - the shell alone grants nothing.
- Credential in **`~/.claude/argus-auth.json`, mode 600**, never in `argus.json`: that
  file is written by `updateSettings`, a bulk merge filtered only by the DEFAULT_CONFIG
  allowlist, and a password must not be reachable by the path that writes a checkbox.
- scrypt + 16-byte salt, `timingSafeEqual`. Read fresh on every check (no mtime cache) so
  a password change takes effect on the very next request.
- Token: 32 random bytes, in-memory Map, carried as `?auth=` on `/nonce` and the WS URL.
  A cookie was rejected: the dev page is served by Vite on another port, so it would drag
  in CORS-with-credentials, and a browser cannot set headers on a WS handshake anyway.
- `/login` requires `Content-Type: application/json` (forces a preflight cross-origin) and
  returns the token in the body rather than as a cookie, so a cross-site POST can neither
  be made silently nor read the answer.
- Lockout: 5 failures per address, then 30s doubling to 15 min; a success clears it.
  An unconfigured server answers `403` and does **not** count the attempt.

**Rollback**: delete the credential file -> remote access is refused again (the safe
direction), local unaffected. Reverting the feature entirely needs the code reverted.

## Changes made

- `src/backend/auth.ts` (new) - credential file, scrypt hash/verify, session map, lockout.
- `src/backend/index.ts` - `/login`, the `/nonce` gate, the upgrade gate, `enforceAuth()`,
  CORS for the cross-origin dev path.
- `src/backend/session.ts` - `getAuthStatus` / `setAuthPassword` / `clearAuthPassword` /
  `signOutAll` + the `onAuthChange` hook.
- `webview/public/ws-bridge.js` - `createArgusAuth` (token storage, login POST,
  `auth_required`), `window.argusAuthRequired`.
- `webview/index.html`, `media/browser.html` - token on `/nonce` and the WS URL, 401 ->
  `auth_required`, `window.argusLogin`.
- `webview/src/components/LoginScreen.tsx` + css (new), `App.tsx`, `reducer.ts`,
  `SettingsModal.tsx` (`AuthSection`), `global.d.ts`.
- `webview/src/components/shared/PasswordInput.tsx` + css (new) - reveal toggle shared by
  all four password fields (login + the three in Settings).
- `playwright.config.ts` + `.gitignore` - `ARGUS_AUTH_FILE` pinned to a throwaway path so
  a suite run can never read or write the real credential.
- e2e: `remote-auth.spec.ts` (mock + compiled credential store),
  `remote-auth-integration.spec.ts`.

## Gotchas

- **`auth_required` fires before React exists.** The shim's first connect runs while the
  bundle is still evaluating, so the event was dispatched to nobody - and because
  `setRequired` dedupes, it never fired again: the remote page showed the chat with the
  socket looping on 401 in the console. Fixed with `window.argusAuthRequired()`, read once
  on mount. Same trap the deep-link replay hit (CLAUDE.md: "deferred to webviewReady").
  **The login screen tested green in isolation and was still invisible in the browser** -
  only the hands-on pass caught it.
- `req.url === '/nonce'` was an exact match, so `?auth=` would have missed the route
  entirely. Switched to the parsed path.
- **The reveal toggle looked centred on the desktop and low on a phone.** A block wrapper
  around an inline `<input>` establishes an inline formatting context, so its line box
  carries the font strut and the wrapper ends up taller than the field - by an amount
  that depends on the device font metrics. Measured: a tall font added **30px** of wrapper
  height under `display: block` and none under `display: flex`. The invariant worth
  asserting is `wrapper height == input height`, not a pixel offset.
- **Static assets were served with no cache headers at all**, so a phone that had loaded
  the page once kept its bundle and silently missed every later build - which is how the
  fixed layout kept rendering old on the device while the server served the new one.
  `Cache-Control: no-cache` added to the static allowlist responses.
- A dev server restarts itself on `src/backend/**` edits, so the gate went live on the
  user's running `yarn dev` mid-session - their phone was refused on :3001 while the
  daemon on :51852 (older build) kept working.

## Test-run findings

- **`authFilePath()` replaced an import-time constant.** The credential spec failed in the
  suite because `auth.js` had resolved `AUTH_FILE` before the spec set the override, so it
  read the developer real `~/.claude/argus-auth.json`, found the record and correctly
  refused to overwrite it. Resolving the path per call removes the class of bug; the path
  is also pinned for every worker in `playwright.config.ts` as defence in depth.
- **One failure was not mine and proving that took a worktree.**
  `session-browse-during-stream:147` failed 3/3 on this tree and passed 4/4 on partial
  trees, which read as a regression. The same code passes in a clean worktree: the real
  variable is that this workspace holds **1949 transcripts** (`listSessions` 775ms) versus
  30 in a temp one (2ms), so the spec races a reply whose cost grows with workspace age.
  Written up in [../../common/e2e-testing.md](../../common/e2e-testing.md).

## Decisions

- **The reveal toggle is `type="button"`.** It sits inside the login `<form>`, where a
  button defaults to `type="submit"` - the eye would have fired a login attempt on every
  click. Pinned by a test that stubs the login and asserts no error appears.
- **Visibility is per field and never persisted.** A revealed password surviving a reopen
  would sit on screen for someone who has forgotten they turned it on.

- **Credential in its own 600-mode file** rather than `argus.json`. Costs one more file;
  wrong only if everything should live in one config.
- **Min length 8.** Wrong if a short PIN is wanted on a trusted LAN; change
  `MIN_PASSWORD_LENGTH`.
- **Changing the password requires the current one.** Stops a hijacked session locking the
  owner out; costs a field in the form.
- **No `authenticated` column in Connected clients** - it was in the plan and dropped:
  every remote client that is connected is authenticated by definition now, so the column
  would always read the same and the `remote` badge already carries the meaning.

## Follow-ups

- `POST /logout` for a single device.
- Audit #4/#5/#8 remain open.
- Sessions have no idle expiry (they die with the process, per the chosen option); an
  absolute cap would be a small addition if daemons start living for weeks.
