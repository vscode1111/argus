# Persistent Codex permissions

## Goal

Keep the selected Codex permission level across conversations and page reloads. Default to Full when no level has been saved.

## Prior art and design

`InputArea` owns the permission picker and sends the selected `mode` with each message. It previously initialized and reset that state to Edit/Ask. Other interface preferences already use `localStorage`. The picker now reads a validated `argus.codexPermissionMode` value, writes it on selection, and restores it whenever Codex becomes the active provider. Claude uses its own permission preference (see [persistent-claude-permissions](../persistent-claude-permissions/notes.md)).

## Verification

- `yarn build` passed.
- A fresh browser context displayed Full by default. After selecting Ask, a new tab displayed Ask; switching to Claude and back restored Ask. This was checked in a separate browser context against the running dev interface.
- `provider-picker.spec.ts` now covers the same default and saved-selection behavior. The Playwright test harness was not run because the active dev server uses the user's config rather than the isolated e2e config.
