// When a background task finishes, the CLI writes itself a user-role prompt and answers it
// in a turn of its own. That prompt is XML, and it is the only record anywhere that says
// *why* the turn happened:
//
//   <task-notification>
//   <task-id>bp24zwu32</task-id>
//   <tool-use-id>toolu_01Ne9...</tool-use-id>
//   <output-file>C:\Users\...\tasks\bp24zwu32.output</output-file>
//   <status>completed</status>
//   <summary>Background command "Watch CI until all checks complete" completed (exit code 0)</summary>
//   </task-notification>
//
// That prompt is a *transcript* record, so only the replay path (sessions.loadSession) parses
// it. The live stream never carries it: measured against a real CLI by
// scripts/probe-notification-event.js in !notes/tasks/bg-turn-cause-marker/, where a full
// background-task cycle emitted three `user` events, all of them tool_results with no
// `origin`, and the notification arrived instead as one `system`/`task_notification` event
// carrying the same five fields. `noticeFromSystemEvent` builds the identical TaskNotice from
// those, so the two paths still produce one shape.
export interface TaskNotice {
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  status?: string;
  summary?: string;
}

// The summary is CLI-generated and short; the cap is here so a malformed record cannot put
// an unbounded string on the wire and into every client's message list.
const MAX_FIELD = 500;

const FIELDS: Array<[keyof TaskNotice, RegExp]> = [
  ['taskId', /<task-id>([\s\S]*?)<\/task-id>/],
  ['toolUseId', /<tool-use-id>([\s\S]*?)<\/tool-use-id>/],
  ['outputFile', /<output-file>([\s\S]*?)<\/output-file>/],
  ['status', /<status>([\s\S]*?)<\/status>/],
  ['summary', /<summary>([\s\S]*?)<\/summary>/],
];

export function parseTaskNotification(text: string): TaskNotice | null {
  if (!text.includes('<task-notification>')) return null;
  const notice: TaskNotice = {};
  for (const [key, re] of FIELDS) {
    const value = re.exec(text)?.[1]?.trim();
    if (value) notice[key] = value.slice(0, MAX_FIELD);
  }
  // A notice with no summary and no id says nothing a reader can act on, and rendering an
  // empty marker is worse than rendering none: it would claim a cause and then not name it.
  return notice.summary || notice.taskId ? notice : null;
}

/** The live counterpart: the same notice built from the `system`/`task_notification` event's
 *  own fields, no parsing involved. Captured shape:
 *  `{type:'system', subtype:'task_notification', task_id, tool_use_id, status, output_file,
 *    summary, session_id, uuid}`. */
export function noticeFromSystemEvent(event: Record<string, unknown>): TaskNotice | null {
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, MAX_FIELD) : undefined);
  const notice: TaskNotice = {
    taskId: str(event.task_id),
    toolUseId: str(event.tool_use_id),
    outputFile: str(event.output_file),
    status: str(event.status),
    summary: str(event.summary),
  };
  return notice.summary || notice.taskId ? notice : null;
}

/** The line shown to the user. The CLI's own summary already reads as a sentence
 *  ("Background command "..." completed (exit code 0)"), so it is used verbatim; the
 *  fallback exists only for a record that lost it. */
export function noticeLabel(notice: TaskNotice): string {
  if (notice.summary) return notice.summary;
  const status = notice.status ?? 'finished';
  return `Background task ${notice.taskId ?? ''} ${status}`.replace(/\s+/g, ' ').trim();
}
