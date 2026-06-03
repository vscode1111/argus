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

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: ToolCallData }
  | { type: 'user_inject'; text: string };

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
  bgTasksCompleted?: number;
  bgTasksTotal?: number;
};

export type Outcome = 'success' | 'stopped' | 'error' | 'retried' | 'background_waiting' | 'background_done';

export type SessionSummary = {
  id: string;
  title: string;
  lastPrompt: string;
  updatedAt: number; // epoch ms
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
  backgroundWaiting?: boolean;
  askPausedAt?: number;
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
};
