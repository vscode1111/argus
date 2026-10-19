import type { ReactNode } from 'react';
import type { ShellKind } from '../utils/shellCommand';
import styles from './ShellIcon.module.css';

const LABELS: Record<ShellKind, string> = {
  powershell: 'PowerShell', bash: 'Bash', cmd: 'Command Prompt',
  zsh: 'Zsh', fish: 'Fish', sh: 'Shell', orchestrate: 'Orchestration',
  node: 'Node.js', git: 'Git', grep: 'Grep', rg: 'ripgrep', sed: 'sed',
  cat: 'cat', npm: 'npm', yarn: 'Yarn',
};

const COMMAND_ICONS: Partial<Record<ShellKind, ReactNode>> = {
  node: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 1.5 21 6.7v10.6L12 22.5 3 17.3V6.7z" fill="currentColor" />
      <text x="12" y="15.5" textAnchor="middle" fill="white" fontFamily="sans-serif" fontWeight="bold" fontSize="8">JS</text>
    </svg>
  ),
  git: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 1 23 12 12 23 1 12z" fill="currentColor" />
      <path d="M8 8v8m0-5 8 5" fill="none" stroke="white" strokeWidth="1.8" />
      <circle cx="8" cy="8" r="1.6" fill="white" /><circle cx="8" cy="16" r="1.6" fill="white" /><circle cx="16" cy="16" r="1.6" fill="white" />
    </svg>
  ),
  grep: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 2h12v18H3z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6 6h6M6 9h5M6 12h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="15" cy="15" r="4" fill="var(--bg)" stroke="currentColor" strokeWidth="2" />
      <path d="m18 18 3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  rg: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="m15.2 15.2 5.3 5.3M11 5 7.5 11H11l-1 4 4-6h-3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  sed: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  cat: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 2h9l5 5v15H5zM14 2v5h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8 11h8M8 14h8M8 17h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  npm: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M1 5h22v14H12v-4H8v4H1z" fill="currentColor" />
      <text x="12" y="13" textAnchor="middle" fill="white" fontFamily="monospace" fontWeight="bold" fontSize="8">npm</text>
    </svg>
  ),
  yarn: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 8c1 3 3 4 5 4s4-1 5-4M8 15c2-3 6-3 8 0m-4-3v7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
};

export function ShellIcon({ shell, command, className }: { shell: ShellKind; command: string; className?: string }) {
  const commandIcon = COMMAND_ICONS[shell];
  return (
    <span className={[styles.icon, styles[shell], className].filter(Boolean).join(' ')} role="img" aria-label={LABELS[shell]} title={command}>
      {shell === 'orchestrate' ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 5v14m0-7h12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="6" cy="5" r="2" fill="currentColor" />
          <circle cx="6" cy="19" r="2" fill="currentColor" />
          <circle cx="18" cy="12" r="2" fill="currentColor" />
        </svg>
      ) : shell === 'powershell' ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 3h18l-3 18H1z" fill="#2671be" />
          <path d="m6 8 4 4-5 4m8 0h5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : commandIcon ? commandIcon : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="1" y="2" width="22" height="20" rx="3" fill="currentColor" />
          <text x="4" y="16" fill="white" fontFamily="monospace" fontWeight="bold" fontSize={shell === 'cmd' ? '8' : '13'}>
            {shell === 'cmd' ? 'C:>' : shell === 'zsh' ? '%_' : shell === 'fish' ? '>_' : '$_'}
          </text>
        </svg>
      )}
    </span>
  );
}
