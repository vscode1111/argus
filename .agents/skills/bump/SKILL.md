---
name: bump
description: Bump the Argus package version by patch, minor, or major without tagging or committing.
---

# Bump the Argus version

When asked to bump the version, read `package.json` and use the requested `patch`, `minor`, or `major` increment. Default to `patch` when no increment is given. If the request specifies something else, report the current version and ask which increment to use.

Change only the `version` field in `package.json`. Preserve the file's other content and formatting. Do not run `npm version` or `yarn version`, create a tag, or commit. Report the old and new versions.
