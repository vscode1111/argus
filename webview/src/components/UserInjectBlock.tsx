import React, { useState, useCallback } from 'react';
import msg from './shared/message.module.css';

export function UserInjectBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <div className={msg.userInject}>
      {text}
      <button className={msg.userInjectCopy} onClick={handleCopy} title="Copy to clipboard" aria-label="Copy to clipboard">{copied ? '✓' : '⧉'}</button>
    </div>
  );
}
