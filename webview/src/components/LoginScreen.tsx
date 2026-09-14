import React, { useEffect, useRef, useState } from 'react';
import { PasswordInput } from './shared/PasswordInput';
import styles from './LoginScreen.module.css';

/**
 * Shown when the server refuses to hand this client a nonce because it is a remote peer
 * with no session. There is nothing behind it - no transcript, no connection - so it
 * takes the whole surface rather than sitting over a chat the user cannot use.
 *
 * The submit path is `window.argusLogin`, published by the browser host shims. It is
 * absent in the VS Code webview, which is always a local peer and never gets here.
 */
export function LoginScreen() {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => { userRef.current?.focus(); }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.argusLogin?.(user, password);
      if (!result) { setError('This build cannot sign in from here.'); return; }
      if (!result.ok) {
        // A lockout is a different answer from a wrong password, and saying "invalid
        // credentials" while the server is refusing to even look at them would send the
        // user hunting for a typo that isn't there.
        setError(result.retryAfterMs
          ? `Too many attempts. Try again in ${Math.ceil(result.retryAfterMs / 1000)}s.`
          : result.error ?? 'Sign in failed.');
        setPassword('');
        return;
      }
      // Success dispatches auth_required:false and reconnects; this component unmounts.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.screen} data-testid="login-screen">
      <form className={styles.card} onSubmit={submit}>
        <h1 className={styles.title}>Argus</h1>
        <p className={styles.subtitle}>This server requires a sign-in for remote access.</p>

        <label className={styles.label} htmlFor="login-user">User</label>
        <input
          id="login-user"
          ref={userRef}
          className={styles.input}
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
        />

        <label className={styles.label} htmlFor="login-password">Password</label>
        <div className={styles.pwField}>
        <PasswordInput
          id="login-password"
          className={styles.input}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          disabled={busy}
        />
        </div>

        {error && <div className={styles.error} data-testid="login-error">{error}</div>}

        <button className={styles.submit} type="submit" disabled={busy || !password}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>

        {/* Stated rather than implied: the password crosses the network in the clear
            unless something else is providing the encryption. */}
        <p className={styles.note}>
          Sent over plain HTTP on this network. Use a tunnel or VPN if the network is not
          yours.
        </p>
      </form>
    </div>
  );
}
