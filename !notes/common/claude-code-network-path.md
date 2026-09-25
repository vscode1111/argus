# Claude CLI cannot reach the API through the Hiddify TUN

Measured 2026-09-25 on the dev machine (Windows 10, Hiddify with a `sing-tun` TUN). Investigation log: [tasks/cli-connection-error-hiddify/notes.md](../tasks/cli-connection-error-hiddify/notes.md).

## Symptom

- Terminal CLI: `retrying (10/10)`; with `--debug` each attempt logs `API error (attempt n/11): undefined Connection error.` and `Stale connection, disabling keep-alive for retry`. The real cause is **not** logged (`undefined`).
- VS Code extension: `API Error: Connection dropped (ECONNRESET)`.
- Argus spawns the same CLI, so its live and integration turns fail the same way.
- Only the inference call (`POST /v1/messages`, always far above 8 KB because of tool schemas and `CLAUDE.md`) fails. Telemetry, bootstrap and MCP-list calls to the same host succeed, which is why the CLI starts fine and then stalls at the first prompt.

## Fix in place

`C:\Users\Admin\.claude\settings.json` carries `env.HTTPS_PROXY=http://127.0.0.1:12334` (Hiddify's local mixed inbound) and `env.NO_PROXY=localhost,127.0.0.1,::1,.lan,192.168.0.0/16`. Verified: CLI 2.1.282 from the Argus folder answered `ok` in 6 s, 2 of 2 runs, with the proxy variables stripped from the shell (`env -u`) so only the settings file could supply them. Three earlier runs (7 s each) inherited the same variables from the shell, so they show the values work but not that the file alone supplies them. Not yet tested: the VS Code extension and the Argus daemon.

Consequences to remember:

- **Hiddify must be running**, or every Claude Code request fails. If connection errors appear, check that first.
- The variables also reach the Bash tool (they showed up in the session shell right after the edit, no restart), so a company host that is not `.lan` may need adding to `NO_PROXY`.
- The fault below is **still there**; the proxy only routes around it for Claude Code.

## What was measured

Same machine, same network, direct route (Hiddify TUN active, no proxy variable):

| CLI version | Direct to the API |
|---|---|
| 2.1.270, 2.1.274 | works, `ok` in 7 s |
| 2.1.277, 2.1.280, 2.1.281, 2.1.282 | fails, 7 to 8 "Connection error" lines |

First broken release is 2.1.275, 2.1.276 or 2.1.277 (not bisected further). 270 and 281 embed the same Bun v1.4.3 and send the same ~511 KB HTTP/1.1 keep-alive request with near-identical headers, so neither the TLS library nor the request shape explains the difference. No network-related `CLAUDE_CODE_*` variable appears between 274 and 277.

Independent of the CLI, a Node probe ([common/scripts/tls-upload-probe.js](scripts/tls-upload-probe.js)) reproduces a size-dependent fault on the direct route:

| Client and case | Result |
|---|---|
| Node built-in path, TLS 1.3, body under ~7.8 KB | HTTP 401 (healthy) |
| Node built-in path, TLS 1.3, body from ~7.8 KB up (binary search, 7796 ok / 7812 fail) | `ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC`, on IPv4 and IPv6, on `api.anthropic.com` **and** `speed.cloudflare.com` |
| Node built-in path, TLS 1.2 forced, up to 200 KB | passes (4 of 4 repeats, plus 8 and 32 KB) |
| Node with a **hand-built** `tls.connect()` socket passed via `createConnection`, TLS 1.2 or 1.3 | fails at 200 KB, even TLS 1.2 |
| TLS 1.3 server on loopback, 1 to 200 KB | passes (so this machine's OpenSSL and CPU are fine) |
| `curl` (Schannel) 200 KB, direct and via the proxy | passes, but Windows 10 Schannel speaks TLS 1.2, so this says nothing about TLS 1.3 |
| Real CLI 2.1.282 via `HTTPS_PROXY`, 3 parallel runs | 3 of 3 `ok`, 0 errors |

`BAD_RECORD_MAC` is an alert **received from the peer**: it rejected our encrypted bytes as corrupted.

## Ruled out (each had a test that could have shown otherwise)

- **The Argus project, the working directory, the CA bundle**: identical failure from `C:\Users\Admin`, and with `NODE_EXTRA_CA_CERTS` unset.
- **Windows-side MTU**: `tun0` at 9000 versus 1400 (`netsh interface ipv4 set subinterface "tun0" mtu=1400 store=active`, reverted afterwards): no change. Only the OS interface was changed, not Hiddify's own `mtu` in its config.
- **`TCP_NODELAY`**: toggled on both paths: no change.
- **IPv6 versus IPv4**, **request shape**, **Bun version**: see above.

## Not established

- **Where the bytes are damaged.** The TUN is a suspect (`stack: gvisor`, `mtu: 9000`, `auto_route`), and the proxy path avoids the CLI failure, but the proxy path was **not** given a valid control: a Node probe through CONNECT needs a hand-built socket, which fails on its own. Do not read "the proxy path also failed my probe" as evidence against the proxy.
- **Why the trigger depends on TLS version and on who builds the socket**, given that the tunnel should treat the bytes as opaque. Timing or first-flight shape is a guess.
- **Why CLI 2.1.277 and newer trip it while 274 does not**, given an identical request. Untested guess: a change in write chunking or connection setup.
- **Whether the CLI update caused it or only coincided.** The CLI 2.1.282 binary was installed at 10:18 and Hiddify rewrote its active config at 10:34 local the same day (the June copy in `C:\PortableSoft\Hiddify\data\` has no TUN section). The version table shows the CLI matters, but a network change that day has not been excluded.

## Reproduce and diagnose

1. Is the direct path broken for the CLI? `claude -p "reply with the single word ok" --model haiku --no-session-persistence --debug --debug-file f.log < /dev/null` and count `Connection error` in `f.log`. Add `< /dev/null`, otherwise the CLI waits 3 s for stdin.
2. Is it the network or the CLI? `node scripts/tls-upload-probe.js` prints a table and a `VERDICT`. `SIGNATURE` means the path fault; `path healthy` means look elsewhere.
3. Is it the CLI version? Install the version into an isolated folder and run step 1 with that binary (see Traps).
4. Compare requests between versions without TLS: run a tiny HTTP server that logs `bodyBytes` and headers, set `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and `ANTHROPIC_API_KEY=sk-ant-scub-probe`, and answer 500. This is how the "same 511 KB request" claim was checked.

## Traps

- **Probing with `curl` on Windows 10 proves nothing about TLS 1.3.** It looked healthy the whole time.
- **A hand-built TLS socket is not a control.** It fails on TLS 1.2 where Node's own path passes; the first version of the probe used one and reported a false "TLS 1.2 fails too". Any probe of this fault must be seen to fire on a known-bad path and pass on a known-good one.
- **`npm install @anthropic-ai/claude-code@<v>` into a scratch folder** (`npm init -y` then install; never global) leaves `bin/claude.exe` as a **500-byte stub** until the platform package finishes. Check the size (about 230 to 240 MB) before running it. Three parallel installs took 3 to 6 minutes through the TUN and about 1.1 GB on `C:`; delete them afterwards, `C:` can fill up ([common/development.md](development.md)).
- **The `env` block of `settings.json` applies to the running session's Bash tool immediately.** A "settings-only" test must strip the variables with `env -u HTTPS_PROXY -u NO_PROXY`, otherwise the CLI inherits them from the shell and the settings file is never tested.
- **Git Bash rewrites arguments that start with `/`** (`-subj "/CN=localhost"`, a URL path `/__up`) into `C:/Program Files/Git/...`. Prefix the command with `MSYS_NO_PATHCONV=1`.
- **Node's `res.socket` is `null` by the `end` event**; read `remoteAddress` or the protocol earlier (`req.on('socket')` plus `secureConnect`).

## Still open

Finish the bisect (install 2.1.275 and 2.1.276), try Hiddify's TUN `stack` set to `system` or `mixed` and its own `mtu`, capture packets on `tun0` versus the NIC, and report the version table upstream. Related: [common/cli-bundle-mining.md](cli-bundle-mining.md) for reading strings out of the CLI executable, which was used here to compare versions.
