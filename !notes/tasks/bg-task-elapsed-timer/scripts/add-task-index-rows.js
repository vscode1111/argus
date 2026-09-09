// Adds this session's two task rows to !notes/tasks/INDEX.md (newest first, matching the file's
// existing order). Idempotent. In a file rather than `node -e` because the summaries carry
// backticks and a first inline attempt died on shell quoting before reaching Node at all.
const fs = require('fs');

const F = '!notes/tasks/INDEX.md';
const HEADER = '|--------|--------|---------|\n';
const MARKER = 'bg-task-elapsed-timer/';

const ROWS = [
  '| [bg-task-elapsed-timer/](bg-task-elapsed-timer/) ' +
  '| backend/sessionState+cliHandler+channel, webview/reducer+types+ChatMessage+BackgroundTasksNote, e2e ' +
  '| DONE: a 45-minute CI poller left the screen frozen - the turn timer stopped at 57s and the note under it was static - and the transcript shows the user asking "текущий статус CI" by hand six minutes in; the note now counts up from the task\'s launch, which required `pendingBgTasks` to become a `Map<string, number>` because nothing in the process knew when a task started; the turn\'s own timer stays frozen on purpose (it measures the turn, not the task) and no launch timestamp means no clock at all, since a half-hour poller shown as "3s" is worse than no number - that direction is the second of the two new tests |',

  '| [bash-caption-truncation/](bash-caption-truncation/) ' +
  '| webview/ToolCall+ToolCall.module.css ' +
  '| DONE: a Bash row\'s description rendered as four characters ("Обно…") beside a long `node -e` command and stayed four at any window width, because flex distributes the deficit in proportion to each item\'s content width so both shrink by the same ratio; fixed by naming the item meant to truncate (`.toolSummaryDesc { flex-shrink: 0; max-width: 45% }`) rather than `flex: 1 1 0` on the command, which would have pushed the `Out` link to the far right on short commands |',
];

const before = fs.readFileSync(F, 'utf8');
if (before.includes(MARKER)) { console.log('SKIP (already present)'); process.exit(0); }
if (!before.includes(HEADER)) { console.log('NOT FOUND - table header missing, nothing written'); process.exit(1); }
fs.writeFileSync(F, before.replace(HEADER, HEADER + ROWS.join('\n') + '\n'));
console.log('added', ROWS.length, 'rows');
