import React, { useState, useCallback } from 'react';
import msg from './shared/message.module.css';
import { isOrchestratorPrompt } from '../utils/orchestratorMarker';

export function UserInjectBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <div className={[msg.userInject, isOrchestratorPrompt(text) ? msg.orchestrator : ''].filter(Boolean).join(' ')}>
      {text}
      <button className={msg.userInjectCopy} onClick={handleCopy} title="Copy to clipboard" aria-label="Copy to clipboard">{copied ? '✓' : '⧉'}</button>
    </div>
  );
}
