import type { ShellKind } from '../utils/shellCommand';
import styles from './ShellIcon.module.css';

const LABELS: Record<ShellKind, string> = {
  powershell: 'PowerShell', bash: 'Bash', cmd: 'Command Prompt',
  zsh: 'Zsh', fish: 'Fish', sh: 'Shell',
};

export function ShellIcon({ shell, command, className }: { shell: ShellKind; command: string; className?: string }) {
  return (
    <span className={[styles.icon, styles[shell], className].filter(Boolean).join(' ')} role="img" aria-label={LABELS[shell]} title={command}>
      {shell === 'powershell' ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 3h18l-3 18H1z" fill="#2671be" />
          <path d="m6 8 4 4-5 4m8 0h5" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
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
