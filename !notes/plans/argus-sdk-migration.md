# Argus: migrate from stdio to Claude Code SDK

## Problem

Argus daemon (`daemon.js`) currently spawns a separate `claude.exe --print` subprocess per session:

```
Code.exe (daemon, PID 15840) -> cmd.exe -> claude.exe (~220 MB each)
```

With 9 open sessions this costs ~2 GB RAM. Processes accumulate and are not cleaned up when sessions close.

## Goal

Replace subprocess spawning with the Claude Code SDK (`@anthropic-ai/claude-code`) called directly inside the daemon process. Result: zero separate `claude.exe` processes, one daemon handles all sessions.

## Key constraint

Subscription (Pro/Max) only works via `claude login` auth - used by `claude.exe` and the SDK.
Direct Anthropic HTTP API (`api.anthropic.com`) requires a separate API key and is billed per token - subscription does NOT cover it. Do not switch to direct API.

## Architecture comparison

**Current (stdio):**
```
Argus daemon (port 51852)
  |- cmd.exe -> claude.exe  (session 1, ~220 MB)
  |- cmd.exe -> claude.exe  (session 2, ~220 MB)
  |- ...
```

**Target (SDK):**
```
Argus daemon (port 51852)
  |- query() call  (session 1, async generator, no subprocess)
  |- query() call  (session 2, async generator, no subprocess)
  |- ...
```

## SDK usage (claude code sdk)

```ts
import { query, type SDKMessage } from "@anthropic-ai/claude-code";

for await (const message of query({
  prompt: "...",
  options: { tools: [...], outputFormat: "stream-json" }
})) {
  // handle SDKMessage
}
```

Auth is automatic - uses the same `claude login` session as `claude.exe`.

## Migration steps

1. Add `@anthropic-ai/claude-code` as a dependency in the Argus extension package.json (or use the already-installed global version via require path).
2. Replace the `spawn("claude.exe", ["--print", ...])` + stdin/stdout pipe logic in `daemon.js` with `query()` calls.
3. Map the existing stream-json message format to SDK message types (they are the same schema).
4. Test that `--resume <uuid>` sessions still work (SDK supports `resume` option).
5. Verify subscription auth works (no ANTHROPIC_API_KEY needed).

## Notes

- Current daemon: `c:\Users\Admin\.vscode\extensions\local.argus-0.0.69\out\backend\daemon.js`
- Daemon port: 51852 (from `argus.json: daemonPort`)
- Current model: `claude-sonnet-4-6` (from `argus.json: runtimeDefaultModel`)
- Clients connecting to daemon: 11 simultaneous connections (all from VS Code extension host PID 3616)
