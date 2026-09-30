# Diagnosing Codex CLI configuration failures

Argus starts the Codex CLI through its provider adapter. A CLI bootstrap error such as `failed to load configuration` happens before a model turn begins; inspect the named `~/.codex/config.toml` line before changing Argus code.

Run the installed CLI's read-only `features list` command as a direct reproduction. On this Windows machine the executable was under `%LOCALAPPDATA%\OpenAI\Codex\bin\<installation>\codex.exe`, outside `PATH`; the server can instead be pointed to it with `ARGUS_CODEX_BIN`. A successful `features list` run confirms that the CLI can parse its configuration without starting a model turn.

TOML rejects a repeated table header even when both copies have the same fields and values. The [duplicate-key task](../tasks/codex-config-duplicate-key/notes.md) found two identical trusted-project tables at lines 1830 and 1839. Removing only the second table changed `features list` from exit 1 to exit 0. The writer that created the duplicate was not identified. Avoid printing configuration values during diagnosis, and check for secrets before editing the file.
