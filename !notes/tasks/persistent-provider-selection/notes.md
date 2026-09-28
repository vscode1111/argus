# Persistent provider selection

## Goal

Keep the selected provider, model, effort, and thinking setting for future conversations. Use Codex with GPT-6-Luna when no selection has been saved.

## Acceptance criteria

- A fresh configuration selects Codex and GPT-6-Luna. Verified by the provider contract test and the account picker integration test.
- A successful provider or model change is saved without a separate action. Verified by a WebSocket integration test that opens a new conversation in another workspace.
- Switching away from Codex and back restores its previously selected model. Verified by the same integration test.
- Existing conversations keep their own selection. The provider contract and integration tests cover independent session selections.

## Prior art and design

`defaultSelection()` in `src/backend/providers/store.ts` already reads `defaultProvider` and `providerDefaults` from `argus.json`. `saveProviderDefault` in `src/backend/providers/requests.ts` was the only write path. The change reuses that write path after validated selection changes and keeps the old request for existing clients. The redundant UI button is removed.

An explicit saved model of `''` still means the CLI default for that provider. Existing saved provider defaults remain authoritative. The new defaults apply to a fresh config or a provider without a saved selection.

## Verification

- `yarn compile`, `yarn build`, and `yarn test:providers` passed.
- Focused Codex integration tests passed for model catalog behavior, automatic persistence, provider switching, and the account picker.
- Focused mock picker tests and Claude model selection integration tests passed.
- `yarn lint` could not start because the `eslint` executable is absent from this installation.

## Local choice

The user's existing `argus.json` contained the old Claude default without a saved provider selection. Its default was set to Codex with the latest selected GPT-6-Sol from this workspace's session metadata. Fresh configurations use GPT-6-Luna until another model is selected.
