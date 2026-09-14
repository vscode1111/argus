import React, { useState } from 'react';
import styles from './passwordInput.module.css';

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** The host's own input styling, so the field matches the form it sits in. */
  className?: string;
  autoComplete?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
          <line x1="1" y1="1" x2="23" y2="23" />
        </>
      ) : (
        <>
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

/**
 * Password field with a reveal toggle. Shared by the login screen and the Settings form
 * so the two cannot drift - and because the field that most needs it is the one typed on
 * a phone, where a long password entered blind is guesswork.
 *
 * Visibility is per-field and never persisted: a revealed password that survived a
 * reopen would be left on screen by someone who has forgotten they turned it on.
 */
export function PasswordInput({ id, value, onChange, className, autoComplete, placeholder, disabled, autoFocus }: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <span className={styles.wrap}>
      <input
        id={id}
        className={[className, styles.input].filter(Boolean).join(' ')}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        spellCheck={false}
        autoCapitalize="none"
      />
      <button
        // type="button" is load-bearing: this sits inside the login <form>, and a button
        // in a form defaults to type="submit" - the eye would submit the login attempt.
        type="button"
        className={styles.eye}
        data-testid="password-reveal"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        onClick={() => setVisible(v => !v)}
        disabled={disabled}
      >
        <EyeIcon off={visible} />
      </button>
    </span>
  );
}
