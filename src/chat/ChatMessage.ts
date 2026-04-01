export type MessageRole = 'user' | 'assistant';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  error?: boolean;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  thinking?: string;
  timestamp: number;
}

export function createUserMessage(content: string): ChatMessage {
  return { id: randomId(), role: 'user', content, timestamp: Date.now() };
}

export function createAssistantMessage(content: string, opts?: { thinking?: string; toolCalls?: ToolCall[] }): ChatMessage {
  return {
    id: randomId(),
    role: 'assistant',
    content,
    thinking: opts?.thinking,
    toolCalls: opts?.toolCalls,
    timestamp: Date.now(),
  };
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
