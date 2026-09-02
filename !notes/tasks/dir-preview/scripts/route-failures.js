// One-shot, idempotent: replace the five inline failure write-ups in notes.md with a
// routing table, now that each lives in the task folder that owns the feature.
const fs = require('fs');
const p = '!notes/tasks/dir-preview/notes.md';
const src = fs.readFileSync(p, 'utf8');
const MARKER = '## Failures found while running the suite';
if (src.includes(MARKER)) { console.log('already routed, nothing to do'); process.exit(0); }

const lines = src.split(/\r?\n/);
const start = lines.findIndex(l => l.startsWith('## Unrelated failure found on the way'));
const end = lines.findIndex(l => l.startsWith('## Remaining work'));
if (start < 0 || end < 0 || end < start) { console.error('section boundaries not found'); process.exit(1); }

const replacement = `${MARKER} (all pre-existing)

Five spec failures surfaced while verifying this work. **None was caused by it** - the only
backend file this task changes is \`filePreview.ts\`, and \`git diff HEAD --stat\` over
\`channel.ts\`, \`sessions.ts\`, \`cliHandler.ts\` and both browser shims is empty. Each is
written up in the task folder that owns the feature:

| Spec | Cause | Where |
|------|-------|-------|
| \`usage-indicator-integration:105\` | loop waited for a third frame that has no sender; **fixed**. Two further diagnoses were wrong and the intermittency is still unexplained | [../usage-limits-indicator/notes.md](../usage-limits-indicator/notes.md) |
| \`account-usage-integration:132\` | guard probed the live API, the server's own fetch then 429'd; **fixed** (skip on the no-data state) | [../account-and-usage/notes.md](../account-and-usage/notes.md) |
| \`getAccountUsage\` sending zero frames | \`execFile\` throws synchronously on \`spawn UNKNOWN\`, rejecting a promise documented as always resolving; **fixed**, and a real product bug (the modal spun forever) | [../../common/request-reply-invariant.md](../../common/request-reply-invariant.md) |
| \`session-active-marker-integration:73\` | waited on a list that is fetched once on mount; **fixed** (drive the Refresh button) | [../session-active-marker/notes.md](../session-active-marker/notes.md) |
| \`version-skew.spec.ts\` (mock) | a real \`workspaceInfo\` reply clobbered the injected client version; **fixed** (drop \`getInfo\` too) | [../version-skew-direction/notes.md](../version-skew-direction/notes.md) |
| \`tool-image-preview-integration:22\` | transcript lookup missed data that was on disk; **unexplained**, passes in isolation | [../image-preview-from-tool-result/notes.md](../image-preview-from-tool-result/notes.md) |

Artifacts preserved here, because \`test-results/\` is wiped at the start of every run:
[failure-usage-indicator/](failure-usage-indicator/), [failure-tool-image/](failure-tool-image/),
[failure-active-marker/](failure-active-marker/), [failure-version-skew/](failure-version-skew/).

The recurring shape is worth naming: **every one of them breaks only under full-suite load
and passes in isolation**, and two of the six are the CLI transcript not being readable when
a test assumes it is. That is one problem, not six flakes.
`;

fs.writeFileSync(p, lines.slice(0, start).concat(replacement.split('\n'), lines.slice(end)).join('\n'));
console.log(`routed: replaced lines ${start + 1}..${end} of notes.md`);
