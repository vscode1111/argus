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
  const lastScrollTop = useRef(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { showLogTime, showLogType, setShowLogTime, setShowLogType } = useSettings();

  const hasMeta = showLogTime || showLogType;
  const metaColWidth = showLogTime ? '100px' : '44px';

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Only an actual upward move counts as the user taking over. Content growth
    // and our own scrollIntoView never decrease scrollTop, so a late scroll event
    // fired after a burst of new entries no longer falsely pauses autoscroll.
    const movedUp = el.scrollTop < lastScrollTop.current - 2;
    lastScrollTop.current = el.scrollTop;
    if (dist < 80) {
      userScrolledUp.current = false;
      setShowScrollBtn(false);
    } else if (movedUp) {
      userScrolledUp.current = true;
      setShowScrollBtn(true);
    }
  }

  function scrollToBottom() {
    userScrolledUp.current = false;
    setShowScrollBtn(false);
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Autoscroll as long as the user hasn't deliberately scrolled up. We gate on
    // the userScrolledUp flag (only updated by real scroll events) instead of the
    // current content-growth distance: a burst of log entries can append more
    // than any fixed threshold in a single render, which previously stopped the
    // autoscroll mid-stream and never re-engaged.
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
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
        <div className={styles.list} ref={listRef} onScroll={handleScroll} data-testid="log-list">
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
