import type { UIMessage, StreamingState, ContentBlock } from '../types';

export interface SubagentSummary {
  id: string;
  path: string;
  active: boolean;
}

export interface SessionActivity {
  agents: SubagentSummary[];
}

export function sessionActivity(messages: UIMessage[], streaming: StreamingState | null): SessionActivity {
  const result: SessionActivity = { agents: [] };
  const agents = new Map<string, SubagentSummary>();
  const blocks: ContentBlock[] = [...messages.flatMap(message => message.blocks ?? []), ...(streaming?.blocks ?? [])];
  for (const block of blocks) {
    if (block.type !== 'tool') continue;
    const { call } = block;
    if (call.kind === 'subAgentActivity') {
      const id = call.input.agentThreadId;
      const path = call.input.agentPath;
      const activity = call.input.activity;
      if (typeof id !== 'string' || typeof path !== 'string') continue;
      if (activity === 'started') agents.set(id, { id, path, active: true });
      else if (activity === 'completed' || activity === 'interrupted') {
        const previous = agents.get(id);
        if (previous) agents.set(id, { ...previous, active: false });
      }
    }
  }
  result.agents = [...agents.values()];
  return result;
}
