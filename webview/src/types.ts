export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  level: LogLevel;
  text: string;
  timestamp: string;
};

export type ImageAttachment = {
  data: string;      // base64 data (without the data:... prefix)
  mediaType: string;  // e.g. "image/png", "image/jpeg", "application/pdf"
  name?: string;     // original filename (for non-image attachments)
};

export type ToolCallData = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  error?: boolean;
};

export type ErrorKind = 'auth' | 'not_found' | 'session' | 'generic';

export type LoginState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'url'; url: string }
  | { phase: 'submitting' }
  | { phase: 'success' }
  | { phase: 'error'; message: string };

/** Why a turn nobody asked for exists: the CLI's own report that a background task
 *  finished. Parsed server-side from the prompt it wrote to itself
 *  (src/backend/taskNotification.ts). */
export type TaskNotice = {
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  status?: string;
  summary?: string;
};

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCallData }
  | { type: 'user_inject'; text: string }
  | { type: 'bg_notice'; notice: TaskNotice };

export type UIMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  images?: ImageAttachment[];
  thinking?: string;
  blocks?: ContentBlock[];
  responseTime?: number;
  finishedAt?: number;
  outcome?: Outcome;
  watchdogRetries?: number;
  errorKind?: ErrorKind;
  bgTasksPending?: number;
  /** When the oldest of those tasks was launched, so the note can count up from it. The
   *  turn's own responseTime cannot stand in: that turn is over and its duration is a fact. */
  bgTasksSince?: number;
  /** The CLI woke itself to report a background task; the user did not start this turn.
   *  It completes like any other, but must not ring the sound or raise an OS toast. */
  autonomous?: boolean;
  finalTokens?: { input: number; output: number };
};

export type Outcome = 'success' | 'stopped' | 'error' | 'retried' | 'background_waiting' | 'background_done';

export type SessionSummary = {
  id: string;
  title: string;
  lastPrompt: string;
  updatedAt: number; // epoch ms
  lines: number; // total lines of text/code across the transcript
};

export type WorkspaceSummary = {
  path: string;
  name: string;
  sessions: number;
  updatedAt: number; // epoch ms
};

// A session with a CLI turn running right now, as reported by the server. Lives
// only in memory (server-side too): it says what is happening, not what happened.
export type ActiveSession = {
  id: string;
  workspacePath: string;
  startedAt: number; // epoch ms the current turn started
};

export type GlobalSessionSummary = SessionSummary & {
  workspacePath: string; // real absolute cwd the session belongs to
  workspaceName: string; // basename for display
};

export type DirEntry = {
  name: string;
  path: string;
};

export type DirListing = {
  path: string;          // resolved directory; '' is the synthetic "This PC" level
  parent: string | null; // null at the synthetic root
  entries: DirEntry[];   // sub-directories only
};

// One row of a directory preview (the `filePreview` reply for a path that turned
// out to be a folder). Unlike DirListing above this carries files too - it is a
// listing to read, not a workspace to pick.
export type PreviewEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size?: number; // bytes, files only
};

export type RetryStatus = {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  autoRetry?: number;
  autoRetryMax?: number;
  timedOut?: boolean;
};

export type StreamingState = {
  thinking: string;
  blocks: ContentBlock[];
  startTime: number;
  lastEventTime: number;
  logsAtStart: number;
  reused: boolean;
  stopped: boolean;
  retryStatus: RetryStatus | null;
  watchdogRetries: number;
  askPausedAt?: number;
  liveTokens?: { input: number; output: number };
};

export type ArgusSettings = {
  verboseTools: boolean;
  showTimer: boolean;
  showOutput: boolean;
  showLogs: boolean;
  showLogTime: boolean;
  showLogType: boolean;
  soundOnComplete: boolean;
  notifyOnComplete: boolean;
  watchdogEnabled: boolean;
  watchdogTimeout: number;
  watchdogAutoRetries: number;
  watchdogRetryDelay: number;
  watchdogDelayFactor: number;
  allowNetworkAccess: boolean;
  allowedOrigins: string;
  daemonPort: number;
  daemonIdleMs: number;
};
