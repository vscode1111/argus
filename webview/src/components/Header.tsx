import React from 'react';
import { postMessage } from '../vscode';

export function Header() {
  return (
    <div id="header">
      <span className="title">Argus</span>
      <button
        id="btn-new-session"
        title="New session"
        onClick={() => postMessage({ type: 'newSession' })}
      >
        +
      </button>
    </div>
  );
}
