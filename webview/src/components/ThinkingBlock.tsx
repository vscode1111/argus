import React, { useState } from 'react';
import styles from './ThinkingBlock.module.css';

interface Props {
  text: string;
}

export function ThinkingBlock({ text }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={[styles.thinkingBlock, expanded && styles.expanded].filter(Boolean).join(' ')}
      onClick={() => setExpanded(e => !e)}
    >
      {text}
    </div>
  );
}
