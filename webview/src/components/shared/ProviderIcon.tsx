import claudeIcon from '../../assets/claude.png?inline';
import styles from './ProviderIcon.module.css';

interface Props {
  providerId: string;
  label?: boolean;
  active?: boolean;
  size?: number;
  className?: string;
}

export function ProviderIcon({ providerId, label = false, active = false, size = 16, className }: Props) {
  if (providerId === 'codex') {
    return <span
      className={[styles.icon, styles.openai, className].filter(Boolean).join(' ')}
      data-provider-icon={providerId}
      style={{ width: size, height: size }}
      role={label ? 'img' : undefined}
      aria-label={label ? active ? 'Codex, working now' : 'Codex' : undefined}
      aria-hidden={label ? undefined : true}
      title={active ? 'Working now' : undefined}
    />;
  }
  if (providerId === 'claude') {
    return <img
      className={[styles.icon, className].filter(Boolean).join(' ')}
      data-provider-icon={providerId}
      style={{ width: size, height: size }}
      src={claudeIcon}
      alt={label ? active ? 'Claude, working now' : 'Claude' : ''}
      aria-hidden={label ? undefined : true}
      title={active ? 'Working now' : undefined}
    />;
  }
  return null;
}
