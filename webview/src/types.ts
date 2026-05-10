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
  | { type: 'tool'; call: ToolCallData };

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
  errorKind?: ErrorKind;
};

export type Outcome = 'success' | 'stopped' | 'error';

export type StreamingState = {
  thinking: string;
  blocks: ContentBlock[];
  startTime: number;
  lastEventTime: number;
  logsAtStart: number;
  reused: boolean;
  stopped: boolean;
};
