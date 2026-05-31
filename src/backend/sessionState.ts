import type { spawn } from 'child_process';
import type { WebSocket } from 'ws';
import type { WatchdogState } from './watchdog';

export interface SessionState {
  ws: WebSocket;
  workspaceDir: string;
  model: string;
  sessionId: string | undefined;
  currentProc: ReturnType<typeof spawn> | undefined;
  currentProcKey: string | undefined;
  toolMap: Map<string, { name: string; input: unknown }>;
  answeredTools: Set<string>;
  pendingAskTools: Set<string>;
  cliDone: boolean;
  userStopped: boolean;
  suppressCliOutput: boolean;
  pendingFollowUp: { answers: Record<string, string>; toolId: string; mode?: string } | undefined;
  pendingBgTasks: Set<string>;
  totalBgTasks: number;
  turnInputTokens: number;
  turnOutputTokens: number;
  buffer: string;
  stderrOutput: string;
  textAccum: string;
  staleTimer: ReturnType<typeof setTimeout> | null;
  lastMessage: { text: string; images?: Array<{ data: string; mediaType: string; name?: string }>; mode?: string } | null;
  receivedDeltas: boolean;
  watchdog: { state: WatchdogState; interval: ReturnType<typeof setInterval> };
  sendLog: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void;
  resetStaleTimer: () => void;
  startStaleTimer: () => void;
  flushAskFollowUp: () => void;
}

export function createSessionState(ws: WebSocket, workspaceDir: string, model: string): SessionState {
  const state: SessionState = {
    ws,
    workspaceDir,
    model,
    sessionId: undefined,
    currentProc: undefined,
    currentProcKey: undefined,
    toolMap: new Map(),
    answeredTools: new Set(),
    pendingAskTools: new Set(),
    cliDone: false,
    userStopped: false,
    suppressCliOutput: false,
    pendingFollowUp: undefined,
    pendingBgTasks: new Set(),
    totalBgTasks: 0,
    turnInputTokens: 0,
    turnOutputTokens: 0,
    buffer: '',
    stderrOutput: '',
    textAccum: '',
    staleTimer: null,
    lastMessage: null,
    receivedDeltas: false,
    watchdog: undefined!,
    sendLog: undefined!,
    resetStaleTimer: undefined!,
    startStaleTimer: undefined!,
    flushAskFollowUp: undefined!,
  };
  return state;
}
