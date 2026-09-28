# Header shortcuts

## Goal

Place the workspace tile, usage indicator, and model tile in that order. Make each header control open its matching view.

## Acceptance criteria and evidence

- The workspace tile precedes the usage indicator, which precedes the model tile. Verified against the rendered DOM in a fresh browser tab.
- The workspace tile opens Workspace History. Verified in the same browser test.
- The model tile opens Account on Models, and the usage indicator opens Account & Usage, even if the other tab was last used. Verified by closing and reopening each path in the browser test.

## Prior art and design

`WorkspaceMenu` already opens Workspace History. `AccountUsageModal` already supports both tabs and remembers manual tab changes. The header now passes an explicit initial tab, while other Account entry points keep their remembered-tab behavior. No backend contract changed.

## Verification

`yarn compile` and `yarn build` passed. A fresh browser tab showed the exact order and confirmed that all three controls open their matching views. The focused Playwright integration test passed before the final order correction; the rerun was stopped by the test harness because a user dev server on port 3001 was using the real configuration. The server was left running.
