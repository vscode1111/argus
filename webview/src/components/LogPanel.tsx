import React, { useEffect, useRef, useState } from 'react';
import { LogEntry } from '../types';
import { useSettings } from '../contexts/SettingsContext';
import styles from './LogPanel.module.css';

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function Toggle({ id, checked, onChange }: ToggleProps) {
  return (
    <span className={styles.toggle}>
      <input id={id} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className={styles.toggleTrack} aria-hidden="true" />
    </span>
  );
}

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
  onClose: () => void;
}

export function LogPanel({ logs, onClear, onClose }: LogPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { showLogTime, showLogType, setShowLogTime, setShowLogType } = useSettings();

  const hasMeta = showLogTime || showLogType;
  const metaColWidth = showLogTime ? '100px' : '44px';

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = dist > 80;
    setShowScrollBtn(dist > 80);
  }

  function scrollToBottom() {
    userScrolledUp.current = false;
    setShowScrollBtn(false);
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    // dist already includes the just-appended entry (~24-60px), so use a generous threshold
    if (dist < 200) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      userScrolledUp.current = false;
      setShowScrollBtn(false);
    }
  }, [logs]);

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Debug Log{logs.length > 0 && ` (${logs.length})`}</span>
        <div className={styles.toolbarActions}>
          <div className={styles.settingsAnchor}>
            <button className={styles.clearBtn} onClick={() => setSettingsOpen(o => !o)} title="Log settings">⚙</button>
            {settingsOpen && (
              <>
                <div className={styles.overlay} onClick={() => setSettingsOpen(false)} />
                <div className={styles.dropdown}>
                  <label className={styles.settingRow} htmlFor="log-toggle-time">
                    <span className={styles.settingLabel}>Show time</span>
                    <Toggle id="log-toggle-time" checked={showLogTime} onChange={setShowLogTime} />
                  </label>
                  <label className={styles.settingRow} htmlFor="log-toggle-type">
                    <span className={styles.settingLabel}>Show type</span>
                    <Toggle id="log-toggle-type" checked={showLogType} onChange={setShowLogType} />
                  </label>
                </div>
              </>
            )}
          </div>
          <button className={styles.clearBtn} onClick={onClear}>Clear</button>
          <button className={styles.closeBtn} onClick={onClose} title="Close log panel">✕</button>
        </div>
      </div>
      <div className={styles.listWrapper}>
        <div className={styles.list} ref={listRef} onScroll={handleScroll}>
          {logs.length === 0 && (
            <div className={styles.empty}>No log entries yet. Send a message to see communication logs.</div>
          )}
          {logs.map((entry, i) => (
            <div key={i} className={hasMeta ? styles.entry : styles.entryNoMeta} style={hasMeta ? { gridTemplateColumns: `${metaColWidth} 1fr` } : undefined}>
              {hasMeta && (
                <div className={styles.meta}>
                  {showLogTime && <span className={styles.timestamp}>{formatTime(entry.timestamp)}</span>}
                  {showLogType && <span className={[styles.level, styles[entry.level]].join(' ')}>{entry.level.toUpperCase()}</span>}
                </div>
              )}
              <span className={[styles.text, entry.text.includes('exited with code') ? styles.textExit : entry.text.includes('Spawning claude') ? styles.textSpawn : ''].filter(Boolean).join(' ')}>{entry.text}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        {showScrollBtn && (
          <button className={styles.scrollBtn} onClick={scrollToBottom} aria-label="Scroll to bottom">↓</button>
        )}
      </div>
    </div>
  );
}
