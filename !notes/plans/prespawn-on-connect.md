# Prespawn CLI on WebSocket connect

**Status:** deferred
**Area:** `src/backend/session.ts`

## Problem

The first user message in a session pays the full Claude CLI cold-start cost: Node startup, bundle load, OAuth token check, MCP server init, skill discovery. This adds ~4-5s to the first response even though the process could be started earlier.

## Approach

Spawn the `claude` process when the WebSocket client connects (using the default args for the expected mode) rather than lazily on the first `send`. When the first real message arrives, the process is already warm.

## Benchmarks (from optimizations.md)

| Configuration | Cold run | Run 2 | Run 3 | Avg |
|---|---:|---:|---:|---:|
| Per-send spawn (original) | 12.2s | 9.5s | 8.4s | 10.0s |
| Process reuse (current) | 11.6s | 3.5s | 4.3s | **6.5s** |
| Prespawn on connect (measured) | 7.8s | ~3.5s | ~4.0s | **~4.8s** |

Cold run improves from 11.6s -> 7.8s. Warm turns unchanged (~3-4s).

## Caveats

- The prespawned process must use the same args as the first real send would use (model, effort, thinking, appendSystemPrompt). If these differ (e.g. user changes model before sending), the warm process must be killed and respawned.
- Prespawning a process that never sends a message (tab opened then closed) wastes resources. The idle-exit mechanism on the daemon partially mitigates this.
- Adds complexity to the session init flow; `initChannelSession` currently does not spawn until first send.

## Decision

Skipped for simplicity at the time the process-reuse optimization was implemented. Revisit if first-message latency remains a UX concern after other improvements.
