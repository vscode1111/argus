import React, { useState } from 'react';
import styles from './ThinkingBlock.module.css';

interface Props {
  text: string;
}

export function ThinkingBlock({ text }: Props) {
  const [expanded, setExpanded] = useState(false);
  const tokens = Math.ceil(text.length / 4);
  return (
    <div
      className={[styles.thinkingBlock, expanded && styles.expanded].filter(Boolean).join(' ')}
      onClick={() => setExpanded(e => !e)}
    >
      <div className={styles.header}>
        <span>Thinking...</span>
        {tokens > 0 && <span className={styles.tokenCount}>{tokens} tok</span>}
        <span className={styles.chevron}>›</span>
      </div>
      {expanded && (
        <div className={styles.body}>
          {text.replace(/\n+/g, ' ')}
        </div>
      )}
    </div>
  );
}
