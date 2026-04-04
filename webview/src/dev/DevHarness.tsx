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
  send({ type: 'tool_start', call: { id: '2', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } } });
  await delay(800);
  send({ type: 'tool_end', call: { id: '2', name: 'Bash', input: { command: 'npm test' }, result: 'All 12 tests passed in 1.4s', error: false } });
  await delay(200);
  send({ type: 'text_chunk', text: 'I read the file and ran the tests. Everything looks good!' });
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
