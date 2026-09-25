# CLI "retrying (10/10)" and ECONNRESET after a CLI update

| | |
|---|---|
| Date | 2026-09-25 |
| Kind | Environment investigation, no product code changed |
| Produced by | Claude Code, model claude-sonnet-5, /update-notes after the session |
| Durable facts | [common/claude-code-network-path.md](../../common/claude-code-network-path.md) |
| Probe script | [common/scripts/tls-upload-probe.js](../../common/scripts/tls-upload-probe.js) |

## Problem

After the Claude Code CLI updated (2.1.282 installed 10:18 local), sessions started from the Argus folder showed `retrying (10/10)` and the VS Code extension showed `API Error: Connection dropped (ECONNRESET)`. The user asked why it worked before the update.

## Result

Fixed for Claude Code by routing it through Hiddify's local proxy: `env.HTTPS_PROXY` and `env.NO_PROXY` in `C:\Users\Admin\.claude\settings.json`. The user confirmed "It works". The underlying network fault and the reason newer CLI versions trip it are **not** understood; see the common doc's "Not established".

## Timeline of hypotheses

| # | Hypothesis | Test | Verdict |
|---|---|---|---|
| 1 | Argus project, cwd or CA bundle | real CLI from Argus vs `C:\Users\Admin`, with and without `NODE_EXTRA_CA_CERTS` | dead, identical failure |
| 2 | Any connection to the API is broken | curl x5, telemetry and bootstrap calls in the debug log | dead, small requests succeed |
| 3 | Large requests corrupted in transit | Node POST sweep 0.1 to 200 KB | survives: fails from ~7.8 KB, `BAD_RECORD_MAC` |
| 4 | MTU 9000 on `tun0` | Windows-side MTU set to 1400 | dead (Hiddify's own `mtu` not touched) |
| 5 | Only Anthropic or one IP family | Cloudflare host, IPv4 and IPv6 | dead, same fault everywhere |
| 6 | Client OpenSSL or CPU fault | TLS 1.3 server on loopback, 200 KB | dead, passes |
| 7 | TLS 1.3 records specifically | TLS 1.2 forced via Node built-in path | partly true, incomplete (next row) |
| 8 | "TLS 1.2 fixes it" | hand-built TLS 1.2 socket | dead as stated: fails too, so the trigger depends on connection setup, not TLS version alone |
| 9 | `TCP_NODELAY` segmentation | toggled on both paths | dead |
| 10 | "The CLI is not the cause" (my first answer to the user) | ran 2.1.270 and 2.1.274 direct | **wrong**: they work, 277+ fail |
| 11 | Bun runtime changed | grep embedded version | dead, Bun v1.4.3 in 270 and 281 |
| 12 | Request shape changed | local logging server via `ANTHROPIC_BASE_URL` | dead, same 511 KB HTTP/1.1 request |

## Gotchas (wrong turns and misleading signals)

- **I told the user the CLI was "probably not" the cause** after a Node-only reproduction. A repro without the CLI shows the fault exists; it does not show the CLI is irrelevant. The version test contradicted me. Test the suspect directly before ruling it out.
- **`curl` looked healthy** because Schannel on Windows 10 negotiates TLS 1.2. It was reported as "the network is fine" for two rounds.
- **The first probe script reported a false "TLS 1.2 fails too"** because it used a hand-built TLS socket, which fails on its own. The fresh control (rerun of the original-style test, 4 of 4 TLS 1.2 pass) caught it before it reached the notes, but only because I checked a result that contradicted an earlier claim. Fixed by dropping proxy mode from the script.
- **My "settings-only" verification was not isolated**: the running session's shell inherited `HTTPS_PROXY` from `settings.json` the moment I saved it. Rerun with `env -u`.
- **Node proxy-path result is uninterpretable** (needs a hand-built socket), so "the proxy also failed my probe" must not be read as evidence about the proxy.
- The install of five old CLI versions cost 1.1 GB on `C:` and 3 to 6 minutes each round through the TUN; the `claude.exe` is a 500-byte stub until npm finishes.
- Tooling: Git Bash turned `/CN=localhost` and `/__up` into Windows paths (`MSYS_NO_PATHCONV=1`); a foreground `sleep` poll loop was blocked by the long-wait hook.

## Decisions

- **Proxy via `settings.json` rather than a machine-wide `HTTPS_PROXY`** (option A over touching Hiddify's TUN settings): scoped to Claude Code, reversible in one edit, covers the CLI, the extension and Argus. Cost: Hiddify must be running. Chosen by the user.
- **`NO_PROXY` includes `.lan` and `192.168.0.0/16`** so company hosts reached via OpenVPN and LAN addresses do not go into Hiddify.

## Changes made

- `C:\Users\Admin\.claude\settings.json`: added the `env` block (re-read and JSON-parsed after the edit).
- Auto-memory `claude-code-hiddify-proxy.md` (explains why the block must not be removed as cleanup).
- Notes: this file, the common doc, the probe script, index rows, a pointer in [common/development.md](../../common/development.md).
- Temporary `tun0` MTU change and five scratch CLI installs were reverted or deleted.

## Remaining work

- Not tested: VS Code extension and Argus daemon actually picking up the settings (the user reported it works, on which surface is not stated).
- Finish the bisect (2.1.275, 2.1.276); try Hiddify TUN `stack` `system` or `mixed` and its own `mtu`; capture on `tun0` versus the NIC; report the version table upstream.
- If a future CLI works direct again, the proxy may be droppable: test with `env -u HTTPS_PROXY`.
