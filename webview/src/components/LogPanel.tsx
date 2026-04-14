import React, { useEffect, useRef } from 'react';
import { LogEntry } from '../types';
import styles from './LogPanel.module.css';

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
}

export function LogPanel({ logs, onClear }: LogPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [logs]);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Debug Log</span>
        <button className={styles.clearBtn} onClick={onClear}>Clear</button>
      </div>
      <div className={styles.list}>
        {logs.length === 0 && (
          <div className={styles.empty}>No log entries yet. Send a message to see communication logs.</div>
        )}
        {logs.map((entry, i) => (
          <div key={i} className={styles.entry}>
            <span className={styles.timestamp}>{formatTime(entry.timestamp)}</span>
            <span className={[styles.level, styles[entry.level]].join(' ')}>{entry.level.toUpperCase()}</span>
            <span className={styles.text}>{entry.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
