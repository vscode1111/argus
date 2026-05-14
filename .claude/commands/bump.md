---
description: Bump the version in package.json (patch, minor, or major). Defaults to patch if no argument given.
---

Bump the project version in `package.json`.

Argument: $ARGUMENTS

## Modes

- `patch` (default) - increment patch version (e.g. 0.0.35 -> 0.0.36)
- `minor` - increment minor version (e.g. 0.0.35 -> 0.1.0)
- `major` - increment major version (e.g. 0.0.35 -> 1.0.0)

## Steps

1. Read the current version from `package.json`.
2. Parse the argument. If empty, default to `patch`.
3. If the argument is not `patch`, `minor`, or `major`, show the current version and ask the user to pick.
4. Compute the new version.
5. Update only the `"version"` field in `package.json`. Do not reformat or touch any other lines.
6. Output: `version_old -> version_new`.

## Rules

- Do not run `npm version` or `yarn version` as they may create git tags or commits.
- Only edit the `"version"` line in `package.json`. Preserve everything else exactly.
- Do not commit. The user will commit when ready.
