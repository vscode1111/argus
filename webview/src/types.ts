export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  level: LogLevel;
  text: string;
  timestamp: string;
};

export type ImageAttachment = {
  data: string;      // base64 data (without the data:... prefix)
  mediaType: string;  // e.g. "image/png", "image/jpeg"
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

export type UIMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  images?: ImageAttachment[];
  thinking?: string;
  toolCalls?: ToolCallData[];
  responseTime?: number;
  errorKind?: ErrorKind;
};

export type StreamingState = {
  thinking: string;
  text: string;
  toolCalls: ToolCallData[];
  startTime: number;
  lastEventTime: number;
};
