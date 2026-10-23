import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WebSocket } from 'ws';
import type { Channel } from '../src/backend/channel';

test('returning to a live session restores its token counts after snapshot replay', async () => {
  const { createSessionState } = require('../out/backend/sessionState') as typeof import('../src/backend/sessionState');
  const { handleResumeSession } = require('../out/backend/session') as typeof import('../src/backend/session');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-token-return-'));
  const projectDir = path.join(os.homedir(), '.claude', 'projects', path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, '-'));
  const id = randomUUID();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), [
    JSON.stringify({ type: 'system', subtype: 'init', cwd: workspace, session_id: id }),
    JSON.stringify({ type: 'user', cwd: workspace, message: { role: 'user', content: 'Previous request' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Previous reply' }] } }),
  ].join('\n') + '\n');

  try {
    const state = createSessionState(workspace);
    state.sessionId = id;
    state.currentProc = {} as typeof state.currentProc;
    state.cliDone = false;
    state.liveInputTokens = 123;
    state.completedOutputTokens = 7;
    state.liveOutputChars = 20;
    state.sendLog = () => {};
    const frames: Record<string, unknown>[] = [];
    const ws = { send: (frame: string) => frames.push(JSON.parse(frame)) } as unknown as WebSocket;
    const channel = {
      attachToLiveSession: () => undefined,
      setBrowsing: () => {},
      getViewingSessionId: () => undefined,
      getClientState: () => state,
      replaySnapshot: () => ws.send(JSON.stringify({ type: 'thinking_start', reused: true })),
    } as unknown as Channel;

    await handleResumeSession(state, ws, channel, id);

    expect(frames.map(frame => frame.type)).toEqual(['providerSelection', 'sessionLoaded', 'thinking_start', 'token_update']);
    expect(frames.at(-1)).toMatchObject({ inputTokens: 123, outputTokens: 12 });
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('joining a live session receives token counts with its snapshot', () => {
  const { getOrCreateChannel, destroyChannel } = require('../out/backend/channel') as typeof import('../src/backend/channel');
  const workspace = path.join(os.tmpdir(), `argus-token-join-${randomUUID()}`);
  const channel = getOrCreateChannel(workspace);
  const origin = { readyState: 1, send() {} } as unknown as WebSocket;
  const frames: Record<string, unknown>[] = [];
  const viewer = { readyState: 1, send: (frame: string) => frames.push(JSON.parse(frame)) } as unknown as WebSocket;
  try {
    channel.addClient(origin, true);
    const state = channel.getClientState(origin);
    state.sessionId = randomUUID();
    state.currentProc = {} as typeof state.currentProc;
    state.cliDone = false;
    state.broadcast(JSON.stringify({ type: 'thinking_start' }));
    state.liveInputTokens = 123;
    state.completedOutputTokens = 7;
    state.liveOutputChars = 20;
    state.broadcast(JSON.stringify({ type: 'token_update', inputTokens: 123, outputTokens: 12 }));

    channel.addClient(viewer);
    expect(frames.some(frame => frame.type === 'thinking_start')).toBe(true);
    expect(frames.find(frame => frame.type === 'token_update')).toMatchObject({ inputTokens: 123, outputTokens: 12 });

    const linkedFrames: Record<string, unknown>[] = [];
    const linkedViewer = { readyState: 1, send: (frame: string) => linkedFrames.push(JSON.parse(frame)) } as unknown as WebSocket;
    channel.addClient(linkedViewer, false, state.sessionId);
    channel.replayHistory(linkedViewer);
    expect(linkedFrames.find(frame => frame.type === 'token_update')).toMatchObject({ inputTokens: 123, outputTokens: 12 });

    state.cliDone = true;
    state.broadcast(JSON.stringify({ type: 'done' }));
    const idleFrames: Record<string, unknown>[] = [];
    const idleViewer = { readyState: 1, send: (frame: string) => idleFrames.push(JSON.parse(frame)) } as unknown as WebSocket;
    channel.addClient(idleViewer);
    expect(idleFrames.some(frame => frame.type === 'token_update')).toBe(false);
  } finally {
    destroyChannel(workspace);
  }
});
