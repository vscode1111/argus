# Duplicate project table in local Codex configuration

## Problem

Argus displayed `failed to load configuration` after a turn. The CLI reported `config.toml:1839:11: duplicate key`.

## Reproduction

Run `node !notes/tasks/codex-config-duplicate-key/scripts/reproduce.js`. It invokes the installed CLI's read-only `features list` command and asserts a successful configuration load. Before the fix, it exited 1 with `failed to load bootstrap configuration` and a duplicate-key error at line 1839. After the fix, the same command exited 0.

## Root cause

The local `~/.codex/config.toml` contained two identical `[projects.'c:\users\admin\.agents']` tables, at lines 1830 and 1839. Both had `trust_level = "trusted"`. TOML disallows duplicate table definitions, so the CLI failed before starting a turn. Argus only displayed the CLI error; its source has no `config.toml` or `trust_level` writer. The process that added the second table is not established.

## Fix

Removed the second identical table from the local configuration. No project source code changed.

## Verification

- The same CLI reproduction now exits 0.
- The project table appears once in the configuration.

## Related tasks

- [Codex CLI configuration diagnostics](../../common/codex-cli-configuration.md) covers the reusable diagnosis.
