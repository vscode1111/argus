import React, { useState } from 'react';

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
  log('debug', 'user message: 1 block(s) [tool_result:toolu_abc123]');
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
  await delay(100);
  log('debug', 'stdin: 312 bytes');
  send({ type: 'thinking_start' });
  await delay(200);
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
  await delay(80);
  log('debug', 'stdin: 512 bytes');
  send({ type: 'thinking_start' });
  await delay(300);
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
  send({ type: 'text_chunk', text: 'I read the file and ran the tests. Everything looks good!' });
  await delay(100);
  log('info', 'claude exited with code 0');
  send({ type: 'done' });
}

async function simulateReads() {
  const files = [
    {
      id: 'r1',
      path: 'D:/_Projects/vscode1111/common-scripts/package.json',
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
      path: 'D:/_Projects/vscode1111/common-scripts/README.md',
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
      path: 'D:/_Projects/vscode1111/common-scripts/src/scripts/cleaningComputer.ts',
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
    send({ type: 'tool_start', call: { id: f.id, name: 'Read', input: { file_path: f.path } } });
    await delay(500);
    send({ type: 'tool_end', call: { id: f.id, name: 'Read', input: { file_path: f.path }, result: f.result } });
    await delay(200);
  }
  send({ type: 'text_chunk', text: 'Read all 3 files successfully.' });
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

async function simulateRichText() {
  send({ type: 'thinking_start' });
  await delay(300);
  send({ type: 'text_chunk', text: [
    '## Code Review Results\n',
    'I found several issues in the codebase:\n',
    '### 1. Missing null check\n',
    'D:\\_Projects\\vscode1111\\argus\\webview\\src\\App.tsx:390\n',
    'The `state` variable can be `undefined` when the component first mounts, but it\'s accessed without a guard.\n',
    '### 2. Unused import\n',
    '`D:\\_Projects\\vscode1111\\argus\\webview\\src\\utils\\markdown.tsx:4`\n',
    'The `remarkBreaks` import is only used conditionally. Consider lazy loading.\n',
    '### 3. Hardcoded path in config\n',
    'File: D:\\_Projects\\vscode1111\\argus\\server\\index.ts:31-48\n',
    '```ts\nconst MODEL = process.env.ARGUS_MODEL ?? "claude-opus-4-6";\n```\n',
    'This should be read from a config file instead.\n',
    '| File | Line | Severity |\n',
    '|------|------|----------|\n',
    '| D:\\_Projects\\vscode1111\\argus\\webview\\src\\App.tsx:390 | 390 | High |\n',
    '| D:\\_Projects\\vscode1111\\argus\\package.json | 5 | Low |\n',
    '| D:\\_Projects\\vscode1111\\argus\\webview\\src\\utils\\filePath.tsx:9 | 9 | Medium |\n',
    '\nAlso check **D:\\_Projects\\vscode1111\\argus\\src\\extension.ts** for the activation entry point.\n',
    'And the _config_ at D:\\_Projects\\vscode1111\\argus\\src\\utils\\config.ts handles settings.',
  ].join('') });
  await delay(100);
  send({ type: 'done' });
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
}

function Btn({ label, onClick, bg = '#0e639c' }: BtnProps) {
  return (
    <button style={{ ...BTN_STYLES, background: bg }} onClick={onClick}>
      {label}
    </button>
  );
}

export function DevHarness() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem('argus.showDevHarness') === 'true';
    } catch { return false; }
  });

  React.useEffect(() => {
    document.body.classList.toggle('dev-harness-visible', visible);
    try { localStorage.setItem('argus.showDevHarness', String(visible)); } catch {}
  }, [visible]);

  React.useEffect(() => {
    const handler = () => setVisible(v => !v);
    window.addEventListener('devharness-toggle', handler);
    return () => window.removeEventListener('devharness-toggle', handler);
  }, []);

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      background: '#1a1a2e',
      borderTop: '1px solid #444',
      padding: '5px 10px',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      zIndex: 9999,
    }}>
          <Btn label="user msg" onClick={() => send({
            type: 'message',
            message: { id: String(Date.now()), role: 'user', content: 'Can you help me refactor this component?' },
          })} />
          <Btn label="stream" onClick={simulateStream} />
          <Btn label="tools" onClick={simulateTools} />
          <Btn label="reads" onClick={simulateReads} bg="#2d6a4f" />
          <Btn label="todos" onClick={simulateTodos} bg="#5a5a2f" />
          <Btn label="agent" onClick={simulateAgent} bg="#5a5a2f" />
          <Btn label="ask" onClick={simulateAskUser} bg="#3a5a7a" />
          <Btn label="ask:answer" onClick={simulateAskAnswer} bg="#3a5a7a" />
          <Btn label="todos" onClick={simulateTodos} bg="#2d5a6a" />
          <Btn label="logs" onClick={simulateLogs} bg="#5a3e7a" />
          <Btn label="err:auth" onClick={() => simulateError('auth')} bg="#7a2020" />
          <Btn label="err:session" onClick={() => simulateError('session')} bg="#7a2020" />
          <Btn label="err:generic" onClick={() => simulateError('generic')} bg="#7a2020" />
          <Btn label="login:url" onClick={simulateLoginUrl} bg="#5a6a2f" />
          <Btn label="login:ok" onClick={simulateLoginSuccess} bg="#2d6a4f" />
          <Btn label="login:fail" onClick={simulateLoginFail} bg="#7a2020" />
          <Btn label="notify" onClick={async () => {
            send({ type: 'thinking_start' });
            await delay(300);
            send({ type: 'text_chunk', text: 'Done.' });
            send({ type: 'done' });
          }} bg="#6a5a2d" />
          <Btn label="rich+paths" onClick={simulateRichText} bg="#6a4a2d" />
          <Btn label="clear" onClick={() => send({ type: 'clear' })} bg="#444" />
          <Btn label="prefill" onClick={() => send({ type: 'prefill', text: 'Explain this function' })} bg="#444" />
          <button
            onClick={() => setVisible(false)}
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '2px 4px' }}
            title="Close dev toolbar"
          >
            ✕
          </button>
    </div>
  );
}
