import type { spawn } from 'child_process';
import type { WatchdogState } from './watchdog';
import type { RateLimitInfo } from './accountUsage';

export interface SessionState {
  broadcast: (msg: string) => void;
  workspaceDir: string;
  // Server-level fallback model (ARGUS_MODEL / startServer option). The active
  // model/effort/thinking are always derived fresh from readConfig() at use time
  // (getInfo, CLI spawn) so a config change in any workspace or process is never
  // shadowed by per-entry cached state.
  serverDefaultModel: string;
  sessionId: string | undefined;
  currentProc: ReturnType<typeof spawn> | undefined;
  currentProcKey: string | undefined;
  toolMap: Map<string, { name: string; input: unknown }>;
  answeredTools: Set<string>;
  pendingAskTools: Set<string>;
  cliDone: boolean;
  // True while the turn in flight is one the CLI started on its own (a background-task
  // notification), false while it is the one the user asked for. handleResult needs the
  // difference: both kinds of turn report `origin.kind === 'task-notification'`.
  autonomousTurn: boolean;
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
  receivedThinkingDeltas: boolean;
  liveOutputChars: number;
  completedOutputTokens: number;
  liveInputTokens: number;
  rateLimits: Map<string, RateLimitInfo>;
  watchdog: { state: WatchdogState; interval: ReturnType<typeof setInterval> };
  sendLog: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void;
  resetStaleTimer: () => void;
  startStaleTimer: () => void;
  flushAskFollowUp: () => void;
  // Triggers a synthetic send event (for watchdog retry and AskUserQuestion follow-ups)
  // without going through a WebSocket - calls handleSend directly on the shared state.
  emitSyntheticSend: (msgStr: string) => void;
}

export function createSessionState(workspaceDir: string): SessionState {
  const state: SessionState = {
    broadcast: undefined!,
    workspaceDir,
    serverDefaultModel: '',
    sessionId: undefined,
    currentProc: undefined,
    currentProcKey: undefined,
    toolMap: new Map(),
    answeredTools: new Set(),
    pendingAskTools: new Set(),
    cliDone: false,
    autonomousTurn: false,
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
    receivedThinkingDeltas: false,
    liveOutputChars: 0,
    completedOutputTokens: 0,
    liveInputTokens: 0,
    rateLimits: new Map(),
    watchdog: undefined!,
    sendLog: undefined!,
    resetStaleTimer: undefined!,
    startStaleTimer: undefined!,
    flushAskFollowUp: undefined!,
    emitSyntheticSend: undefined!,
  };
  return state;
}
