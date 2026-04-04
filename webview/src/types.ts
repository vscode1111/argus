export type ToolCallData = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  error?: boolean;
};

export type UIMessage = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  thinking?: string;
  toolCalls?: ToolCallData[];
  responseTime?: number;
};

export type StreamingState = {
  thinking: string;
  text: string;
  toolCalls: ToolCallData[];
  startTime: number;
  lastEventTime: number;
};
