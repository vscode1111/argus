import React, { useState, useCallback, useRef } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';
import styles from './DevHarness.module.css';

function send(data: object) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function log(level: 'debug' | 'info' | 'warn' | 'error', text: string) {
  send({ type: 'log', level, text, timestamp: new Date().toISOString() });
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function simulateLogs() {
  log('info', 'Spawning claude: --print --verbose --output-format stream-json --input-format stream-json --model claude-opus-4-6 --allowedTools Read,Write,Edit,Bash,Glob,Grep');
  await delay(50);
  log('debug', 'stdin: 421 bytes');
  await delay(300);
  log('debug', 'event: system {"type":"system","subtype":"init","session_id":"sess_abc123"}');
  await delay(100);
  log('debug', 'event: content_block_start {"type":"content_block_start","index":0}');
  await delay(200);
  log('debug', 'event: content_block_delta {"type":"content_block_delta","index":0}');
  await delay(150);
  log('info', 'tool_start: Read (toolu_abc123)');
  await delay(600);
  log('debug', 'user message: 1 block [tool_result:toolu_abc123]');
  log('debug', 'tool_result toolu_abc123: import React from "react";\nimport { useReducer } from "react";');
  await delay(200);
  log('debug', 'event: content_block_delta {"type":"content_block_delta","index":2}');
  await delay(300);
  log('warn', 'stderr: [DEBUG] OAuth token check starting');
  await delay(100);
  log('info', 'claude exited with code 0');
}

async function simulateStream() {
  log('info', 'Spawning claude: --print --verbose --output-format stream-json --input-format stream-json --model claude-opus-4-6');
  send({ type: 'thinking_start' });
  await delay(100);
  log('debug', 'stdin: 312 bytes');
  await delay(2000);
  log('debug', 'event: system {"type":"system","subtype":"init","session_id":"sess_dev"}');
  await delay(1500);
  send({ type: 'thinking_chunk', text: 'Analyzing the request...' });
  await delay(400);
  send({ type: 'thinking_chunk', text: ' Breaking it down step by step.' });
  await delay(500);
  send({ type: 'text_chunk', text: '# Response\n\nHere is a **streaming** response with `inline code`.' });
  await delay(150);
  send({ type: 'text_chunk', text: '\n\n```ts\nconst x: number = 42;\nconsole.log(x);\n```' });
  await delay(150);
  send({ type: 'text_chunk', text: '\n\nAnd a table:\n\n| Column A | Column B |\n|----------|----------|\n| foo | bar |\n| baz | qux |' });
  await delay(200);
  log('info', 'claude exited with code 0');
  send({ type: 'done' });
}

async function simulateTools() {
  log('info', 'Spawning claude: --print --verbose --output-format stream-json --input-format stream-json --model claude-opus-4-6');
  send({ type: 'thinking_start' });
  await delay(80);
  log('debug', 'stdin: 512 bytes');
  await delay(1800);
  log('debug', 'event: system {"type":"system","subtype":"init","session_id":"sess_dev"}');
  await delay(800);
  log('info', 'tool_start: Read (toolu_001)');
  send({ type: 'tool_start', call: { id: '1', name: 'Read', input: { file_path: '/src/App.tsx' } } });
  await delay(600);
  log('debug', 'tool_result toolu_001: import React from "react";');
  send({ type: 'tool_end', call: { id: '1', name: 'Read', input: { file_path: '/src/App.tsx' }, result: 'import React from "react";\nimport { useReducer } from "react";\n// ... 120 more lines' } });
  await delay(200);
  log('info', 'tool_start: Bash (toolu_002)');
  send({ type: 'tool_start', call: { id: '2', name: 'Bash', input: { command: 'find src -type f -name "*.ts" | head -20', description: 'List TypeScript files' } } });
  await delay(800);
  log('debug', 'tool_result toolu_002: src/index.ts src/common/config.ts ...');
  send({ type: 'tool_end', call: { id: '2', name: 'Bash', input: { command: 'find src -type f -name "*.ts" | head -20' }, result: 'src/index.ts\nsrc/common/config.ts\nsrc/common/types.ts\nsrc/common/converts.ts\nsrc/common/files.ts\nsrc/scripts/index.ts\nsrc/scripts/constants.ts\nsrc/scripts/changeProject.ts\nsrc/scripts/cleaningComputer.ts\nsrc/scripts/gitUpdate.ts', error: false } });
  await delay(200);
  log('info', 'tool_start: Edit (toolu_003)');
  send({ type: 'tool_start', call: { id: '3', name: 'Edit', input: { file_path: '/src/common/config.ts', old_string: '  version: "0.0.9",', new_string: '  version: "0.0.10",' } } });
  await delay(400);
  log('debug', 'tool_result toolu_003: File edited successfully');
  send({ type: 'tool_end', call: { id: '3', name: 'Edit', input: { file_path: '/src/common/config.ts', old_string: '  version: "0.0.9",', new_string: '  version: "0.0.10",' }, result: 'File edited successfully' } });
  await delay(200);
  send({ type: 'tool_start', call: { id: '4', name: 'Edit', input: { file_path: 'D:/_Projects/scub111g/argus/webview/src/components/ToolCall.module.css', old_string: '.toolSummary {\n  color: var(--thinking-fg);\n}', new_string: '.toolSummary {\n  color: var(--thinking-fg);\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}' } } });
  await delay(400);
  send({ type: 'tool_end', call: { id: '4', name: 'Edit', input: { file_path: 'D:/_Projects/scub111g/argus/webview/src/components/ToolCall.module.css', old_string: '.toolSummary {\n  color: var(--thinking-fg);\n}', new_string: '.toolSummary {\n  color: var(--thinking-fg);\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}' }, result: 'File edited successfully' } });
  await delay(200);
  send({ type: 'text_chunk', text: 'I read the file and ran the tests. Everything looks good!' });
  await delay(100);
  log('info', 'claude exited with code 0');
  send({ type: 'done' });
}

async function simulateReads() {
  const files = [
    {
      id: 'r1',
      path: 'D:/_Projects/scub111g/common-scripts/package.json',
      result: `     1→{
     2→  "name": "common-scripts",
     3→  "version": "1.0.0",
     4→  "scripts": {
     5→    "archive-projects:dev": "env-cmd -f .env.dev nodemon ...",
     6→    "archive-projects:prod": "env-cmd -f .env node dist/scripts/archiveProjects.js",
     7→    "cleaning-computer:dev": "env-cmd -f .env.dev nodemon ...",
     8→    "build": "tsc && tsc-alias"
     9→  },
    10→  "dependencies": {
    11→    "ethers": "^5.7.2",
    12→    "dayjs": "^1.11.7",
    13→    "axios": "^1.3.4",
    14→    "mysql": "^2.18.1"
    15→  }
    16→}`,
    },
    {
      id: 'r2',
      path: 'D:/_Projects/scub111g/common-scripts/README.md',
      result: `     1→# common-scripts
     2→
     3→Personal automation toolkit for Windows system management.
     4→
     5→## Scripts
     6→
     7→- **archiveProjects** - Archive dev projects (removes node_modules, creates RAR)
     8→- **extractProjects** - Restore projects from latest archive
     9→- **cleaningComputer** - Wipe system caches (npm, yarn, pip, Chrome, VSCode)
    10→- **archiveLife** - Backup MySQL \`life\` database
    11→- **extractLife** - Restore MySQL database from backup
    12→- **changeProject** - Bulk regex find/replace across file tree
    13→
    14→## Usage
    15→
    16→\`\`\`sh
    17→yarn archive-projects:prod
    18→yarn cleaning-computer:prod
    19→\`\`\``,
    },
    {
      id: 'r3',
      path: 'D:/_Projects/scub111g/common-scripts/src/scripts/cleaningComputer.ts',
      result: `     1→import { callWithTimer } from '@common/time';
     2→import { eraseDirectory } from '@common/files';
     3→import { consoleLog } from '@common/log';
     4→
     5→const CACHE_DIRS = [
     6→  'C:/Windows/Temp',
     7→  'C:/Users/Admin/AppData/Local/Temp',
     8→  'C:/Users/Admin/AppData/Roaming/npm-cache',
     9→  'C:/Users/Admin/AppData/Local/Yarn/Cache',
    10→  'C:/Users/Admin/AppData/Local/pip/cache',
    11→  'C:/Users/Admin/AppData/Local/go/pkg',
    12→  'C:/Users/Admin/.cargo/registry/cache',
    13→  'C:/Users/Admin/AppData/Roaming/Code/Cache',
    14→  'C:/Users/Admin/AppData/Local/Google/Chrome/User Data/Default/Cache',
    15→];
    16→
    17→async function main() {
    18→  for (const dir of CACHE_DIRS) {
    19→    await eraseDirectory(dir, { skipErrors: true });
    20→    consoleLog(\`Cleaned: \${dir}\`);
    21→  }
    22→}
    23→
    24→callWithTimer(main);`,
    },
  ];

  send({ type: 'thinking_start' });
  await delay(200);
  for (const f of files) {
    const input: Record<string, unknown> = { file_path: f.path };
    if (f.id === 'r1') { input.limit = 80; }
    if (f.id === 'r3') { input.offset = 5; input.limit = 15; }
    send({ type: 'tool_start', call: { id: f.id, name: 'Read', input } });
    await delay(500);
    send({ type: 'tool_end', call: { id: f.id, name: 'Read', input, result: f.result } });
    await delay(200);
  }
  send({ type: 'text_chunk', text: 'Read all 3 files successfully.' });
  await delay(100);
  send({ type: 'done' });
}

async function simulateSearch() {
  send({ type: 'thinking_start' });
  await delay(200);
  send({ type: 'tool_start', call: { id: 's1', name: 'Glob', input: { pattern: 'skills/directus-query/SKILL.md' } } });
  await delay(300);
  send({ type: 'tool_end', call: { id: 's1', name: 'Glob', input: { pattern: 'skills/directus-query/SKILL.md' }, result: 'No files found' } });
  await delay(200);
  send({ type: 'tool_start', call: { id: 's2', name: 'Glob', input: { pattern: 'src/index.ts' } } });
  await delay(300);
  send({ type: 'tool_end', call: { id: 's2', name: 'Glob', input: { pattern: 'src/index.ts' }, result: 'src/index.ts' } });
  await delay(200);
  send({ type: 'tool_start', call: { id: 's3', name: 'Glob', input: { pattern: '**/*.ts' } } });
  await delay(300);
  send({ type: 'tool_end', call: { id: 's3', name: 'Glob', input: { pattern: '**/*.ts' }, result: 'src/index.ts\nsrc/app.ts\nsrc/utils.ts' } });
  await delay(200);
  send({ type: 'tool_start', call: { id: 's4', name: 'Grep', input: { pattern: 'nonexistent' } } });
  await delay(300);
  send({ type: 'tool_end', call: { id: 's4', name: 'Grep', input: { pattern: 'nonexistent' }, result: 'No matches found' } });
  await delay(200);
  send({ type: 'tool_start', call: { id: 's5', name: 'Grep', input: { pattern: 'useState' } } });
  await delay(300);
  send({ type: 'tool_end', call: { id: 's5', name: 'Grep', input: { pattern: 'useState' }, result: 'src/App.tsx' } });
  await delay(200);
  send({ type: 'tool_start', call: { id: 's6', name: 'Grep', input: { pattern: 'import' } } });
  await delay(300);
  send({ type: 'tool_end', call: { id: 's6', name: 'Grep', input: { pattern: 'import' }, result: 'src/App.tsx\nsrc/Header.tsx' } });
  await delay(200);
  send({ type: 'text_chunk', text: 'Search complete.' });
  await delay(100);
  send({ type: 'done' });
}

async function simulateAgent() {
  send({ type: 'thinking_start' });
  await delay(300);
  send({ type: 'tool_start', call: { id: 'a1', name: 'Agent', input: { description: 'Search for auth patterns', prompt: 'Find all authentication-related code in the codebase', subagent_type: 'Explore' } } });
  await delay(2000);
  send({ type: 'tool_end', call: { id: 'a1', name: 'Agent', input: { description: 'Search for auth patterns', prompt: 'Find all authentication-related code in the codebase', subagent_type: 'Explore' }, result: 'Found 3 auth-related files:\n- src/auth/login.ts\n- src/auth/middleware.ts\n- src/auth/oauth.ts' } });
  await delay(300);
  send({ type: 'tool_start', call: { id: 'a2', name: 'Agent', input: { description: 'Review migration safety', prompt: 'Review migration 0042 for safety under concurrent writes', subagent_type: 'code-reviewer' } } });
  await delay(1500);
  send({ type: 'tool_end', call: { id: 'a2', name: 'Agent', input: { description: 'Review migration safety', prompt: 'Review migration 0042 for safety under concurrent writes', subagent_type: 'code-reviewer' }, result: 'The migration is safe. The backfill uses a default value and does not lock the table.' } });
  await delay(200);
  send({ type: 'text_chunk', text: 'I delegated two sub-tasks to specialized agents. Both completed successfully.' });
  await delay(100);
  send({ type: 'done' });
}

async function simulateTodos() {
  const todos = [
    { id: '1', content: 'Read types.ts', status: 'pending' },
    { id: '2', content: 'Update ToolCall component', status: 'pending' },
    { id: '3', content: 'Build webview bundle', status: 'pending' },
  ];

  send({ type: 'thinking_start' });
  await delay(400);

  // Step 1: start working on first item
  send({ type: 'tool_start', call: { id: 't1', name: 'TodoWrite', input: { todos: [{ ...todos[0], status: 'in_progress' }, todos[1], todos[2]] } } });
  await delay(100);
  send({ type: 'tool_end', call: { id: 't1', name: 'TodoWrite', input: { todos: [{ ...todos[0], status: 'in_progress' }, todos[1], todos[2]] } } });
  await delay(1200);

  // Step 2: first done, second in progress
  send({ type: 'tool_start', call: { id: 't2', name: 'TodoWrite', input: { todos: [{ ...todos[0], status: 'completed' }, { ...todos[1], status: 'in_progress' }, todos[2]] } } });
  await delay(100);
  send({ type: 'tool_end', call: { id: 't2', name: 'TodoWrite', input: { todos: [{ ...todos[0], status: 'completed' }, { ...todos[1], status: 'in_progress' }, todos[2]] } } });
  await delay(1200);

  // Step 3: second done, third in progress
  send({ type: 'tool_start', call: { id: 't3', name: 'TodoWrite', input: { todos: [{ ...todos[0], status: 'completed' }, { ...todos[1], status: 'completed' }, { ...todos[2], status: 'in_progress' }] } } });
  await delay(100);
  send({ type: 'tool_end', call: { id: 't3', name: 'TodoWrite', input: { todos: [{ ...todos[0], status: 'completed' }, { ...todos[1], status: 'completed' }, { ...todos[2], status: 'in_progress' }] } } });
  await delay(1200);

  // Step 4: all done
  send({ type: 'tool_start', call: { id: 't4', name: 'TodoWrite', input: { todos: todos.map(t => ({ ...t, status: 'completed' })) } } });
  await delay(100);
  send({ type: 'tool_end', call: { id: 't4', name: 'TodoWrite', input: { todos: todos.map(t => ({ ...t, status: 'completed' })) } } });
  await delay(300);

  send({ type: 'text_chunk', text: 'All tasks completed.' });
  send({ type: 'done' });
}

const ASK_QUESTIONS = [
  {
    question: 'Which context menu entries do you want to add?',
    header: 'Menu entries',
    multiSelect: true,
    options: [
      { label: 'Open folder (background)', description: 'Right-click on empty area inside a folder -> "Open with Argus"' },
      { label: 'Open folder (item)', description: 'Right-click on a folder in Explorer -> "Open with Argus"' },
      { label: 'Open file', description: 'Right-click on any file -> "Open with Argus"' },
      { label: 'Other' },
    ],
  },
  {
    question: 'How should the registry entries be created?',
    header: 'Format',
    multiSelect: false,
    options: [
      { label: '.reg file (Recommended)', description: 'Standalone .reg file - double-click to import into registry. Simple, portable, easy to review.' },
      { label: 'Node.js script', description: 'Script that adds/removes registry entries programmatically via "reg add" commands.' },
      { label: 'PowerShell script', description: 'PowerShell script using New-Item/Set-ItemProperty for registry manipulation.' },
      { label: 'Other' },
    ],
  },
  {
    question: 'What is the name and path of your wrapper application?',
    header: 'Exe path',
    multiSelect: false,
    options: [
      { label: 'I\'ll provide details', description: 'I\'ll type the app name and executable path' },
      { label: 'Use "Argus" as name', description: 'Context menu will say "Open with Argus", path TBD' },
      { label: 'Other' },
    ],
  },
];

async function simulateAskUser() {
  send({ type: 'thinking_start' });
  await delay(300);
  send({ type: 'tool_start', call: { id: 'ask1', name: 'AskUserQuestion', input: { questions: ASK_QUESTIONS } } });
}

async function simulateAskAnswer() {
  send({ type: 'tool_end', call: { id: 'ask1', name: 'AskUserQuestion', input: { questions: ASK_QUESTIONS }, result: JSON.stringify({ answers: { 'Migration scope': 'Dual mode' } }) } });
  await delay(200);
  send({ type: 'text_chunk', text: 'Got it - I\'ll plan for the dual-mode approach.' });
  send({ type: 'done' });
}

async function simulateDiff() {
  const oldString = [
    '# Project Config',
    '',
    '## Key Conventions',
    '',
    '- Model: `claude-opus-4-6` for agent (adaptive thinking), `claude-haiku-4-5` for inline completions',
    '- Streaming: always use `client.messages.stream()` + `finalMessage()`',
    '- Tool approval: destructive tools (write_file, bash) require user confirmation via `showWarningMessage`',
    '- No Python scripts - use Node.js/TypeScript for any tooling',
    '- Webview UI is React 18 + TypeScript + Vite (lib/IIFE mode). Build with `yarn build`',
    '- Webview styling uses CSS Modules (co-located `.module.css` files) with VS Code CSS variables (`var(--vscode-*)`) - no Tailwind, auto-adapts to any theme',
    '- CSS Modules: camelCase class names for dot access (`styles.toolCall`), conditional classes via `.filter(Boolean).join(\' \')`, shared modules in `components/shared/`, `composes:` for reuse',
    '- Error handling: errors classified into `ErrorKind` (`auth | not_found | session | generic`) via `classifyError()` in `argusServer.ts`; webview shows structured error blocks with contextual actions (Login, Retry, New session); API errors delivered as text content (e.g. "API Error: 403") are detected via a 3-second stale timer in the server and converted to error+done events; if `error` arrives after `done`, the reducer retroactively marks the last assistant message outcome as error',
    '- Unified WebSocket server: `src/argusServer.ts` exports `startServer({ port, model })` used by both the VS Code extension (dynamic port via `port: 0`) and standalone dev mode (`server/index.ts`, port 3001); the extension starts the server on `activate()` and shuts it down on `deactivate()`; `ChatPanel` injects the WS URL into `chat.html`; the webview connects via a shim script that routes Claude-related messages to WS and VS Code-specific messages to real `postMessage`; one port serves many panels (per-connection isolated state)',
    '- Context usage indicator: pill in InputArea (`contextPill`) shows "X%" of 200k context window (full "X% used" in tooltip); extracted from CLI `assistant` event message usage; color-coded: default <50%, yellow (`contextMedium`) 50-80%, red (`contextHigh`) 80%+; tooltip shows token breakdown; persists across messages, resets on clear/new session',
    '',
    '## Development',
    '',
    '```sh',
    'yarn dev          # starts Vite frontend + WebSocket server',
    'yarn build        # bundle React webview',
    '```',
  ].join('\n');

  const newString = [
    '# Project Config',
    '',
    '## Key Conventions',
    '',
    '- Model: `claude-opus-4-6` for agent, `claude-haiku-4-5` for inline completions',
    '- Streaming: always use `client.messages.stream()` + `finalMessage()`',
    '- Tool approval: destructive tools (write_file, bash) require user confirmation',
    '- No Python scripts, use Node.js/TypeScript for any tooling',
    '- Webview UI: React 18 + TypeScript + Vite (lib/IIFE mode), build with `yarn build`',
    '- CSS Modules with VS Code CSS variables (`var(--vscode-*)`), no Tailwind',
    '  - camelCase class names, conditional via `.filter(Boolean).join(\' \')`',
    '  - shared modules in `components/shared/`, `composes:` for reuse',
    '- Error handling: `ErrorKind` (`auth | not_found | session | generic`) via',
    '  `classifyError()` in `argusServer.ts`; contextual actions in webview;',
    '  API errors as text detected via 3-second stale timer;',
    '  late `error` after `done` retroactively marks assistant message outcome',
    '- Unified WS server: `src/argusServer.ts` exports `startServer({ port, model })`',
    '  for both VS Code extension (port 0) and standalone dev (port 3001);',
    '  extension starts on `activate()`, stops on `deactivate()`;',
    '  webview shim routes Claude messages to WS, VS Code messages to postMessage',
    '- Context usage: pill shows "X%" of 200k window; color-coded',
    '  (default <50%, yellow 50-80%, red 80%+); tooltip shows token breakdown;',
    '  persists across messages, resets on clear/new session',
    '',
    '## Development',
    '',
    '```sh',
    'yarn dev          # starts Vite frontend + WebSocket server',
    'yarn build        # bundle React webview',
    'yarn watch        # watch + rebuild on save',
    '```',
  ].join('\n');

  // Second diff: TypeScript refactor with many changes
  const oldTs = [
    'import { spawn, ChildProcess } from "child_process";',
    'import { WebSocket, WebSocketServer } from "ws";',
    'import http from "http";',
    'import path from "path";',
    'import fs from "fs";',
    '',
    'interface ServerOptions {',
    '  port: number;',
    '  model: string;',
    '  debug?: boolean;',
    '}',
    '',
    'const DEFAULT_MODEL = "claude-opus-4-6";',
    'const MAX_RETRIES = 3;',
    'const RETRY_DELAY = 1000;',
    '',
    'export function startServer(options: ServerOptions) {',
    '  const { port, model = DEFAULT_MODEL, debug = false } = options;',
    '  const httpServer = http.createServer((req, res) => {',
    '    if (req.url === "/health") {',
    '      res.writeHead(200, { "Content-Type": "application/json" });',
    '      res.end(JSON.stringify({ status: "ok", model, uptime: process.uptime() }));',
    '      return;',
    '    }',
    '    res.writeHead(404);',
    '    res.end("Not found");',
    '  });',
    '',
    '  const wss = new WebSocketServer({ server: httpServer, path: "/agent" });',
    '',
    '  wss.on("connection", (ws, req) => {',
    '    const dir = new URL(req.url!, `http://${req.headers.host}`).searchParams.get("dir") ?? process.cwd();',
    '    let currentProc: ChildProcess | null = null;',
    '    let sessionId: string | null = null;',
    '    let retryCount = 0;',
    '',
    '    function spawnCli(prompt: string) {',
    '      const args = ["--print", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--model", model];',
    '      currentProc = spawn("claude", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });',
    '      if (debug) console.log(`[server] spawned claude pid=${currentProc.pid}`);',
    '',
    '      currentProc.stdout?.on("data", (chunk: Buffer) => {',
    '        const lines = chunk.toString().split("\\n").filter(Boolean);',
    '        for (const line of lines) {',
    '          try {',
    '            const event = JSON.parse(line);',
    '            handleEvent(event);',
    '          } catch {',
    '            if (debug) console.log("[server] non-JSON stdout:", line.slice(0, 200));',
    '          }',
    '        }',
    '      });',
    '',
    '      currentProc.stderr?.on("data", (chunk: Buffer) => {',
    '        const text = chunk.toString().trim();',
    '        if (text) sendLog("warn", `stderr: ${text}`);',
    '      });',
    '',
    '      currentProc.on("close", (code) => {',
    '        sendLog("info", `claude exited with code ${code}`);',
    '        if (code !== 0 && retryCount < MAX_RETRIES) {',
    '          retryCount++;',
    '          setTimeout(() => spawnCli(prompt), RETRY_DELAY);',
    '        }',
    '        currentProc = null;',
    '      });',
    '    }',
    '',
    '    function handleEvent(event: any) {',
    '      // ... event handling logic',
    '    }',
    '',
    '    function sendLog(level: string, text: string) {',
    '      ws.send(JSON.stringify({ type: "log", level, text, timestamp: new Date().toISOString() }));',
    '    }',
    '',
    '    ws.on("message", (raw) => {',
    '      const msg = JSON.parse(raw.toString());',
    '      if (msg.type === "send") spawnCli(msg.text);',
    '      if (msg.type === "stop") {',
    '        currentProc?.kill("SIGTERM");',
    '        currentProc = null;',
    '      }',
    '    });',
    '',
    '    ws.on("close", () => {',
    '      currentProc?.kill("SIGTERM");',
    '    });',
    '  });',
    '',
    '  httpServer.listen(port, () => {',
    '    console.log(`Server running on port ${port}`);',
    '  });',
    '',
    '  return { httpServer, wss };',
    '}',
  ].join('\n');

  const newTs = [
    'import { spawn, ChildProcess } from "child_process";',
    'import { WebSocket, WebSocketServer } from "ws";',
    'import http from "http";',
    'import path from "path";',
    'import fs from "fs";',
    'import { EventEmitter } from "events";',
    '',
    'interface ServerOptions {',
    '  port: number;',
    '  model: string;',
    '  debug?: boolean;',
    '  maxRetries?: number;',
    '  onError?: (err: Error) => void;',
    '}',
    '',
    'interface ServerResult {',
    '  httpServer: http.Server;',
    '  wss: WebSocketServer;',
    '  port: number;',
    '  close: () => Promise<void>;',
    '}',
    '',
    'const DEFAULT_MODEL = "claude-opus-4-6";',
    'const DEFAULT_MAX_RETRIES = 3;',
    'const RETRY_DELAY = 1000;',
    'const STALE_TIMEOUT = 3000;',
    '',
    'const API_ERROR_RE = /API Error:|Failed to authenticate|overloaded_error/i;',
    '',
    'export function startServer(options: ServerOptions): ServerResult {',
    '  const {',
    '    port,',
    '    model = DEFAULT_MODEL,',
    '    debug = false,',
    '    maxRetries = DEFAULT_MAX_RETRIES,',
    '    onError,',
    '  } = options;',
    '',
    '  const httpServer = http.createServer((req, res) => {',
    '    if (req.url === "/health") {',
    '      res.writeHead(200, { "Content-Type": "application/json" });',
    '      res.end(JSON.stringify({',
    '        status: "ok",',
    '        model,',
    '        uptime: process.uptime(),',
    '        connections: wss.clients.size,',
    '      }));',
    '      return;',
    '    }',
    '    if (req.url === "/version") {',
    '      res.writeHead(200, { "Content-Type": "text/plain" });',
    '      res.end("1.0.0");',
    '      return;',
    '    }',
    '    res.writeHead(404);',
    '    res.end("Not found");',
    '  });',
    '',
    '  const wss = new WebSocketServer({ server: httpServer, path: "/agent" });',
    '',
    '  wss.on("connection", (ws, req) => {',
    '    const url = new URL(req.url!, `http://${req.headers.host}`);',
    '    const dir = url.searchParams.get("dir") ?? process.cwd();',
    '    let currentProc: ChildProcess | null = null;',
    '    let sessionId: string | null = null;',
    '    let retryCount = 0;',
    '    let textAccum = "";',
    '    let staleTimer: ReturnType<typeof setTimeout> | null = null;',
    '    let cliDone = false;',
    '',
    '    function resetStaleTimer() {',
    '      if (staleTimer) clearTimeout(staleTimer);',
    '      staleTimer = null;',
    '    }',
    '',
    '    function startStaleTimer() {',
    '      resetStaleTimer();',
    '      staleTimer = setTimeout(() => {',
    '        if (cliDone) return;',
    '        if (textAccum && API_ERROR_RE.test(textAccum)) {',
    '          cliDone = true;',
    '          ws.send(JSON.stringify({ type: "error", text: textAccum.trim() }));',
    '          ws.send(JSON.stringify({ type: "done" }));',
    '        }',
    '      }, STALE_TIMEOUT);',
    '    }',
    '',
    '    function spawnCli(prompt: string) {',
    '      cliDone = false;',
    '      textAccum = "";',
    '      resetStaleTimer();',
    '      const args = [',
    '        "--print", "--verbose",',
    '        "--output-format", "stream-json",',
    '        "--input-format", "stream-json",',
    '        "--model", model,',
    '      ];',
    '      currentProc = spawn("claude", args, {',
    '        cwd: dir,',
    '        stdio: ["pipe", "pipe", "pipe"],',
    '      });',
    '      sendLog("info", `Spawning claude pid=${currentProc.pid}`);',
    '',
    '      currentProc.stdout?.on("data", (chunk: Buffer) => {',
    '        const lines = chunk.toString().split("\\n").filter(Boolean);',
    '        for (const line of lines) {',
    '          try {',
    '            const event = JSON.parse(line);',
    '            handleEvent(event);',
    '          } catch {',
    '            const trimmed = line.trim();',
    '            if (trimmed && API_ERROR_RE.test(trimmed)) {',
    '              cliDone = true;',
    '              ws.send(JSON.stringify({ type: "error", text: trimmed }));',
    '              ws.send(JSON.stringify({ type: "done" }));',
    '            }',
    '          }',
    '        }',
    '      });',
    '',
    '      currentProc.stderr?.on("data", (chunk: Buffer) => {',
    '        const text = chunk.toString().trim();',
    '        if (text) sendLog("warn", `stderr: ${text}`);',
    '      });',
    '',
    '      currentProc.on("close", (code) => {',
    '        resetStaleTimer();',
    '        sendLog("info", `claude exited with code ${code}`);',
    '        if (code !== 0 && !cliDone) {',
    '          if (retryCount < maxRetries) {',
    '            retryCount++;',
    '            sendLog("warn", `Retry ${retryCount}/${maxRetries}`);',
    '            setTimeout(() => spawnCli(prompt), RETRY_DELAY);',
    '          } else {',
    '            ws.send(JSON.stringify({ type: "error", text: `Exited with code ${code}` }));',
    '            ws.send(JSON.stringify({ type: "done" }));',
    '          }',
    '        }',
    '        currentProc = null;',
    '      });',
    '    }',
    '',
    '    function handleEvent(event: any) {',
    '      if (event.type === "content_block_delta") {',
    '        const delta = event.delta;',
    '        if (delta?.type === "text_delta" && delta.text) {',
    '          textAccum += delta.text;',
    '          startStaleTimer();',
    '          ws.send(JSON.stringify({ type: "text_chunk", text: delta.text }));',
    '        }',
    '      }',
    '    }',
    '',
    '    function sendLog(level: string, text: string) {',
    '      const ts = new Date().toISOString();',
    '      ws.send(JSON.stringify({ type: "log", level, text, timestamp: ts }));',
    '    }',
    '',
    '    ws.on("message", (raw) => {',
    '      const msg = JSON.parse(raw.toString());',
    '      switch (msg.type) {',
    '        case "send":',
    '          retryCount = 0;',
    '          spawnCli(msg.text);',
    '          break;',
    '        case "stop":',
    '          cliDone = true;',
    '          resetStaleTimer();',
    '          currentProc?.kill("SIGTERM");',
    '          currentProc = null;',
    '          ws.send(JSON.stringify({ type: "done" }));',
    '          break;',
    '        case "newSession":',
    '          sessionId = null;',
    '          retryCount = 0;',
    '          break;',
    '      }',
    '    });',
    '',
    '    ws.on("close", () => {',
    '      resetStaleTimer();',
    '      currentProc?.kill("SIGTERM");',
    '    });',
    '  });',
    '',
    '  return new Promise<ServerResult>((resolve) => {',
    '    httpServer.listen(port, () => {',
    '      const addr = httpServer.address();',
    '      const boundPort = typeof addr === "object" ? addr!.port : port;',
    '      console.log(`Server running on port ${boundPort}`);',
    '      resolve({',
    '        httpServer,',
    '        wss,',
    '        port: boundPort,',
    '        close: () => new Promise<void>((r) => {',
    '          wss.close();',
    '          httpServer.close(() => r());',
    '        }),',
    '      });',
    '    });',
    '  }) as any;',
    '}',
  ].join('\n');

  send({ type: 'thinking_start' });
  await delay(200);

  // First edit: CLAUDE.md line wrapping
  send({ type: 'tool_start', call: { id: 'diff1', name: 'Edit', input: { file_path: '/project/CLAUDE.md', old_string: oldString, new_string: newString } } });
  await delay(300);
  send({ type: 'tool_end', call: { id: 'diff1', name: 'Edit', input: { file_path: '/project/CLAUDE.md', old_string: oldString, new_string: newString }, result: 'File edited successfully' } });

  // Second edit: server refactor
  send({ type: 'tool_start', call: { id: 'diff2', name: 'Edit', input: { file_path: '/project/src/argusServer.ts', old_string: oldTs, new_string: newTs } } });
  await delay(300);
  send({ type: 'tool_end', call: { id: 'diff2', name: 'Edit', input: { file_path: '/project/src/argusServer.ts', old_string: oldTs, new_string: newTs }, result: 'File edited successfully' } });

  await delay(200);
  send({ type: 'text_chunk', text: 'Refactored `argusServer.ts`: added stale timer for API error detection, retry logic with configurable max, `/version` endpoint, and proper cleanup on close. Also wrapped long lines in `CLAUDE.md`.' });
  send({ type: 'done' });
}

async function simulateRichText() {
  send({ type: 'thinking_start' });
  await delay(300);
  send({ type: 'text_chunk', text: [
    '## Code Review Results\n',
    'I found several issues in the codebase:\n',
    '### 1. Missing null check\n',
    'D:\\_Projects\\scub111g\\argus\\webview\\src\\App.tsx:120\n',
    'The `state` variable can be `undefined` when the component first mounts, but it\'s accessed without a guard.\n',
    '### 2. Unused import\n',
    '`D:\\_Projects\\scub111g\\argus\\webview\\src\\utils\\markdown.tsx:4`\n',
    'The `remarkBreaks` import is only used conditionally. Consider lazy loading.\n',
    '### 3. Hardcoded path in config\n',
    'File: D:\\_Projects\\scub111g\\argus\\src\\backend\\index.ts:31-48\n',
    '```ts\nconst MODEL = process.env.ARGUS_MODEL ?? "claude-opus-4-6";\n```\n',
    'This should be read from a config file instead.\n',
    '| File | Line | Severity |\n',
    '|------|------|----------|\n',
    '| D:\\_Projects\\scub111g\\argus\\webview\\src\\App.tsx:120 | 120 | High |\n',
    '| D:\\_Projects\\scub111g\\argus\\package.json | 5 | Low |\n',
    '| D:\\_Projects\\scub111g\\argus\\webview\\src\\utils\\filePath.tsx:9 | 9 | Medium |\n',
    '\nAlso check **D:\\_Projects\\scub111g\\argus\\src\\frontend\\extension.ts** for the activation entry point.\n',
    'And the _config_ at D:\\_Projects\\scub111g\\argus\\src\\frontend\\utils\\config.ts handles settings.\n',
    '\n### 4. App icon\n',
    'The icon used in the context menu: D:\\_Projects\\scub111g\\argus\\media\\argus-icon.png',
  ].join('') });
  await delay(100);
  send({ type: 'done' });
}

async function simulateStress() {
  send({ type: 'clear' });
  await delay(50);

  // Generate 10K log entries
  const levels: Array<'debug' | 'info' | 'warn' | 'error'> = ['debug', 'info', 'warn', 'error'];
  const sampleEvents = [
    'event: content_block_delta {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"analyzing"}}',
    'event: assistant {"type":"assistant","message":{"model":"claude-opus-4-6","id":"msg_stress","role":"assistant"}}',
    'event: system {"type":"system","subtype":"init","session_id":"sess_stress_test","cwd":"/project"}',
    'tool_result toolu_stress: import React from "react"; import { useState } from "react";',
    'stdin: 1024 bytes',
    'event: content_block_start {"type":"content_block_start","index":0}',
    'stderr: [DEBUG] Token refresh completed successfully',
    'Spawning claude: --print --verbose --output-format stream-json --input-format stream-json',
  ];
  for (let i = 0; i < 10000; i++) {
    const level = levels[i % levels.length];
    const text = `[${i}] ${sampleEvents[i % sampleEvents.length]}`;
    send({ type: 'log', level, text, timestamp: new Date(Date.now() + i * 50).toISOString() });
  }

  // Generate multiple assistant messages with tool calls
  for (let turn = 0; turn < 20; turn++) {
    send({ type: 'thinking_start' });
    const chunks: string[] = [];
    for (let j = 0; j < 25; j++) {
      chunks.push(`Line ${turn * 25 + j + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n`);
    }
    send({ type: 'text_chunk', text: chunks.join('') });

    // Add 2 tool calls per turn
    const toolId1 = `stress-${turn}-1`;
    const toolId2 = `stress-${turn}-2`;
    send({ type: 'tool_start', call: { id: toolId1, name: 'Read', input: { file_path: `/src/module-${turn}/index.ts` } } });
    send({ type: 'tool_end', call: { id: toolId1, name: 'Read', input: { file_path: `/src/module-${turn}/index.ts` }, result: `export function module${turn}() { return ${turn}; }` } });
    send({ type: 'tool_start', call: { id: toolId2, name: 'Bash', input: { command: `find src/module-${turn} -name "*.ts" | wc -l` } } });
    send({ type: 'tool_end', call: { id: toolId2, name: 'Bash', input: { command: `find src/module-${turn} -name "*.ts" | wc -l` }, result: `${turn + 3}` } });

    send({ type: 'text_chunk', text: `\nTurn ${turn + 1} complete. Processed ${(turn + 1) * 25} lines.\n` });
    send({ type: 'done' });
    await delay(10);
  }
}

async function simulateLoginUrl() {
  send({ type: 'loginUrl', url: 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c5a3e-example' });
}

async function simulateLoginSuccess() {
  send({ type: 'loginResult', success: true });
}

async function simulateLoginFail() {
  send({ type: 'loginResult', success: false, message: 'Invalid authorization code' });
}

async function simulateError(errorKind: string = 'generic') {
  send({ type: 'thinking_start' });
  await delay(400);
  const messages: Record<string, string> = {
    auth: 'claude exited with code 1',
    not_found: 'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code',
    session: 'Session sess_abc123 not found or expired.',
    generic: 'API rate limit exceeded. Please try again in a moment.',
  };
  send({ type: 'error', text: messages[errorKind] ?? messages.generic, errorKind });
}

const BTN_STYLES: React.CSSProperties = {
  border: 'none',
  borderRadius: 3,
  padding: '3px 10px',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'monospace',
  color: '#fff',
};

interface BtnProps {
  label: string;
  onClick: () => void;
  bg?: string;
  desc?: string;
}

function Btn({ label, onClick, bg = '#0e639c', desc }: BtnProps) {
  return (
    <tr>
      <td className={styles.btnCell}>
        <button style={{ ...BTN_STYLES, background: bg }} onClick={onClick}>
          {label}
        </button>
      </td>
      <td className={styles.descCell}>{desc}</td>
    </tr>
  );
}

export function DevHarness() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem('argus.showDevHarness') === 'true';
    } catch { return false; }
  });

  const close = useCallback(() => setVisible(false), []);

  // Draggable position: null until the user drags, then explicit top/left.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => {
    // Ignore drags that start on a button or the search input.
    if ((e.target as HTMLElement).closest('button, input')) return;
    const rect = modalRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      const el = modalRef.current;
      if (!d || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const x = Math.min(Math.max(0, ev.clientX - d.dx), window.innerWidth - w);
      const y = Math.min(Math.max(0, ev.clientY - d.dy), window.innerHeight - h);
      setPos({ x, y });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  React.useEffect(() => {
    try { localStorage.setItem('argus.showDevHarness', String(visible)); } catch {}
  }, [visible]);

  React.useEffect(() => {
    const handler = () => setVisible(v => !v);
    window.addEventListener('devharness-toggle', handler);
    return () => window.removeEventListener('devharness-toggle', handler);
  }, []);

  useEscapeKey(close);

  // Run a mock action but keep the modal open. There's no backdrop, so the
  // chat behind stays visible and usable; drag the modal aside to watch results.
  const run = useCallback((fn: () => void) => () => { fn(); }, []);

  const [query, setQuery] = useState('');

  // Pin the modal's position on the first keystroke so filtering (which
  // shrinks the modal) doesn't re-center it vertically and shift the top edge.
  const onSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const rect = modalRef.current?.getBoundingClientRect();
    if (rect) setPos(p => p ?? { x: rect.left, y: rect.top });
    setQuery(e.target.value);
  }, []);

  if (!visible) return null;

  const buttons: BtnProps[] = [
    { label: 'sound:play', desc: 'Play the completion sound directly (tests "Sound on complete")', onClick: run(() => window.dispatchEvent(new Event('argus:test-sound'))), bg: '#6a5a2d' },
    { label: 'notify:fire', desc: 'Fire a completion notification directly (tests "Notify on complete")', onClick: run(() => window.dispatchEvent(new Event('argus:test-notify'))), bg: '#6a5a2d' },
    { label: 'user msg', desc: 'Inject a user message bubble into the chat', onClick: run(() => send({
      type: 'message',
      message: { id: String(Date.now()), role: 'user', content: 'Can you help me refactor this component?' },
    })) },
    { label: 'stream', desc: 'Simulate a streaming assistant reply (thinking, markdown, code, table) with logs', onClick: run(simulateStream) },
    { label: 'tools', desc: 'Simulate Read/Bash/Edit tool calls with results and a final reply', onClick: run(simulateTools) },
    { label: 'reads', desc: 'Simulate three Read tool calls, incl. offset/limit ranges, for FileViewerModal line highlighting', onClick: run(simulateReads), bg: '#2d6a4f' },
    { label: 'search', desc: 'Simulate Glob/Grep search tool calls with hit and no-match results', onClick: run(simulateSearch), bg: '#2d6a4f' },
    { label: 'todos', desc: 'Simulate a TodoWrite checklist progressing from pending to all completed', onClick: run(simulateTodos), bg: '#5a5a2f' },
    { label: 'agent', desc: 'Simulate two sub-agent (Task) tool calls (Explore + code-reviewer)', onClick: run(simulateAgent), bg: '#5a5a2f' },
    { label: 'ask', desc: 'Open an AskUserQuestion dialog (multi-tab, single/multi-select)', onClick: run(simulateAskUser), bg: '#3a5a7a' },
    { label: 'ask:answer', desc: 'Resolve the pending AskUserQuestion with an answer and follow-up reply', onClick: run(simulateAskAnswer), bg: '#3a5a7a' },
    { label: 'todos', desc: 'Simulate a TodoWrite checklist progressing from pending to all completed', onClick: run(simulateTodos), bg: '#2d5a6a' },
    { label: 'logs', desc: 'Emit a sequence of debug/info/warn log entries into the log panel', onClick: run(simulateLogs), bg: '#5a3e7a' },
    { label: 'err:auth', desc: 'Show an auth error block (Login action)', onClick: run(() => simulateError('auth')), bg: '#7a2020' },
    { label: 'err:session', desc: 'Show a session-not-found error block (New session action)', onClick: run(() => simulateError('session')), bg: '#7a2020' },
    { label: 'err:generic', desc: 'Show a generic error block (Retry action)', onClick: run(() => simulateError('generic')), bg: '#7a2020' },
    { label: 'login:url', desc: 'Show the login panel with an OAuth authorize URL', onClick: run(simulateLoginUrl), bg: '#5a6a2f' },
    { label: 'login:ok', desc: 'Simulate a successful login result', onClick: run(simulateLoginSuccess), bg: '#2d6a4f' },
    { label: 'login:fail', desc: 'Simulate a failed login (invalid authorization code)', onClick: run(simulateLoginFail), bg: '#7a2020' },
    { label: 'notify', desc: 'Quick reply that completes a turn (fires sound/notification on complete)', onClick: run(async () => {
      send({ type: 'thinking_start' });
      await delay(300);
      send({ type: 'text_chunk', text: 'Done.' });
      send({ type: 'done' });
    }), bg: '#6a5a2d' },
    { label: 'img', desc: 'Simulate Read tool calls on image files (renders image previews)', onClick: run(async () => {
      send({ type: 'thinking_start' });
      await delay(100);
      send({ type: 'tool_start', call: { id: 'img1', name: 'Read', input: { file_path: 'media/argus-icon.png' } } });
      await delay(300);
      send({ type: 'tool_end', call: { id: 'img1', name: 'Read', input: { file_path: 'media/argus-icon.png' }, result: '[image data]' } });
      await delay(200);
      send({ type: 'tool_start', call: { id: 'img2', name: 'Read', input: { file_path: 'media/argus-icon.ico' } } });
      await delay(300);
      send({ type: 'tool_end', call: { id: 'img2', name: 'Read', input: { file_path: 'media/argus-icon.ico' }, result: '[image data]' } });
      await delay(100);
      send({ type: 'text_chunk', text: 'Here are the icon files.' });
      send({ type: 'done' });
    }), bg: '#4a6a2d' },
    { label: 'diff', desc: 'Simulate two Edit tool calls (markdown + TypeScript) for DiffViewerModal', onClick: run(simulateDiff), bg: '#4a6a2d' },
    { label: 'rich+paths', desc: 'Render rich markdown with clickable file paths, line refs, and a table', onClick: run(simulateRichText), bg: '#6a4a2d' },
    { label: '10K', desc: 'Stress test: 10,000 log entries + 20 multi-tool assistant messages', onClick: run(simulateStress), bg: '#7a5a20' },
    { label: 'clear', desc: 'Clear all messages and logs', onClick: run(() => send({ type: 'clear' })), bg: '#444' },
    { label: 'prefill', desc: 'Prefill the input box with sample text', onClick: run(() => send({ type: 'prefill', text: 'Explain this function' })), bg: '#444' },
  ];

  const q = query.trim().toLowerCase();
  const filtered = q
    ? buttons.filter(b => b.label.toLowerCase().includes(q) || (b.desc ?? '').toLowerCase().includes(q))
    : buttons;

  return (
    <>
      <div
        ref={modalRef}
        className={styles.modal}
        role="dialog"
        aria-label="Dev Harness"
        style={pos ? { top: pos.y, left: pos.x, transform: 'none' } : undefined}
      >
        <div className={styles.header} onPointerDown={onHeaderPointerDown}>
          <span className={styles.title}>Dev Harness</span>
          <input
            className={styles.search}
            type="text"
            placeholder="Filter buttons..."
            aria-label="Filter buttons"
            value={query}
            onChange={onSearchChange}
          />
          <button className={styles.close} onClick={close} aria-label="Close" title="Close dev harness">&times;</button>
        </div>
        <div className={styles.body}>
          <table className={styles.table}>
            <tbody>
              {filtered.map((b, i) => (
                <Btn key={`${b.label}-${i}`} label={b.label} desc={b.desc} bg={b.bg} onClick={b.onClick} />
              ))}
              {filtered.length === 0 && (
                <tr><td className={styles.empty} colSpan={2}>No buttons match "{query}"</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
