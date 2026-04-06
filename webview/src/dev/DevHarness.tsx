import React, { useState } from 'react';

function send(data: object) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function simulateStream() {
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
  send({ type: 'done' });
}

async function simulateTools() {
  send({ type: 'thinking_start' });
  await delay(300);
  send({ type: 'tool_start', call: { id: '1', name: 'Read', input: { file_path: '/src/App.tsx' } } });
  await delay(600);
  send({ type: 'tool_end', call: { id: '1', name: 'Read', input: { file_path: '/src/App.tsx' }, result: 'import React from "react";\nimport { useReducer } from "react";\n// ... 120 more lines' } });
  await delay(200);
  send({ type: 'tool_start', call: { id: '2', name: 'Bash', input: { command: 'find src -type f -name "*.ts" | head -20', description: 'List TypeScript files' } } });
  await delay(800);
  send({ type: 'tool_end', call: { id: '2', name: 'Bash', input: { command: 'find src -type f -name "*.ts" | head -20' }, result: 'src/index.ts\nsrc/common/config.ts\nsrc/common/types.ts\nsrc/common/converts.ts\nsrc/common/files.ts\nsrc/scripts/index.ts\nsrc/scripts/constants.ts\nsrc/scripts/changeProject.ts\nsrc/scripts/cleaningComputer.ts\nsrc/scripts/gitUpdate.ts', error: false } });
  await delay(200);
  send({ type: 'text_chunk', text: 'I read the file and ran the tests. Everything looks good!' });
  await delay(100);
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

async function simulateError() {
  send({ type: 'thinking_start' });
  await delay(400);
  send({ type: 'error', text: 'API rate limit exceeded. Please try again in a moment.' });
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
  const [visible, setVisible] = useState(true);

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
      <span style={{ color: '#666', fontSize: 11, fontFamily: 'monospace', marginRight: 2 }}>dev</span>

      {visible ? (
        <>
          <Btn label="user msg" onClick={() => send({
            type: 'message',
            message: { id: String(Date.now()), role: 'user', content: 'Can you help me refactor this component?' },
          })} />
          <Btn label="stream" onClick={simulateStream} />
          <Btn label="tools" onClick={simulateTools} />
          <Btn label="reads" onClick={simulateReads} bg="#2d6a4f" />
          <Btn label="error" onClick={simulateError} bg="#7a2020" />
          <Btn label="clear" onClick={() => send({ type: 'clear' })} bg="#444" />
          <Btn label="prefill" onClick={() => send({ type: 'prefill', text: 'Explain this function' })} bg="#444" />
          <button
            onClick={() => setVisible(false)}
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#555', cursor: 'pointer', fontSize: 11 }}
          >
            hide
          </button>
        </>
      ) : (
        <button
          onClick={() => setVisible(true)}
          style={{ background: 'transparent', border: 'none', color: '#555', cursor: 'pointer', fontSize: 11 }}
        >
          show
        </button>
      )}
    </div>
  );
}
