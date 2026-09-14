import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { waitForApp } from './helpers';

// The login screen a remote client meets, and the Settings section that sets the password
// it asks for. `window.argusLogin` is published by the host shims, so the mock run stubs
// it - the point here is what the screen does with each answer, not the transport.

test.describe('remote login screen', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  async function requireAuth(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'auth_required', required: true } }));
    });
    await expect(page.getByTestId('login-screen')).toBeVisible();
  }

  test('replaces the app when the server says this peer must sign in', async ({ page }) => {
    // Control first: without the signal the app is the app, so a build that always
    // rendered the login screen fails here.
    await expect(page.getByTestId('login-screen')).toHaveCount(0);
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();

    await requireAuth(page);
    // Nothing behind it is usable, so it replaces rather than covers.
    await expect(page.getByPlaceholder('Ask Argus')).toHaveCount(0);
  });

  test('a wrong password says so and clears the field, leaving the screen up', async ({ page }) => {
    await requireAuth(page);
    await page.evaluate(() => {
      window.argusLogin = async () => ({ ok: false, status: 401, error: 'invalid credentials' });
    });

    await page.locator('#login-user').fill('scub');
    await page.locator('#login-password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByTestId('login-error')).toHaveText('invalid credentials');
    await expect(page.getByTestId('login-screen')).toBeVisible();
    await expect(page.locator('#login-password')).toHaveValue('');
  });

  test('a lockout is reported as a wait, not as a wrong password', async ({ page }) => {
    // The decisive pair with the test above: told "invalid credentials" while the server
    // is refusing to even look at them, the user hunts for a typo that is not there.
    await requireAuth(page);
    await page.evaluate(() => {
      window.argusLogin = async () => ({ ok: false, status: 429, error: 'too many attempts', retryAfterMs: 30_000 });
    });

    await page.locator('#login-password').fill('scub-whatever');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('login-error')).toContainText('Try again in 30s');
  });

  test('connecting dismisses the screen, whoever caused it', async ({ page }) => {
    await requireAuth(page);
    // A successful login reconnects; the ws_status that follows is what proves the
    // client is authorised, so it must clear the screen even if no event says so.
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'ws_status', connected: true } }));
    });
    await expect(page.getByTestId('login-screen')).toHaveCount(0);
    await expect(page.getByPlaceholder('Ask Argus')).toBeVisible();
  });

  test('Settings says whether remote access is open or refused', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Network' }).click();

    const send = async (payload: object) => page.evaluate(p => {
      window.dispatchEvent(new MessageEvent('message', { data: p }));
    }, payload);

    await send({ type: 'authStatus', configured: false, user: '', sessions: 0, minLength: 8 });
    await expect(page.getByTestId('auth-status')).toHaveText('not set');
    // "No password" must read as a refusal, not as "anyone may connect" - that is the
    // whole point of the strict default.
    await expect(page.getByTestId('auth-hint')).toContainText('refused');

    await send({ type: 'authStatus', configured: true, user: 'scub', sessions: 2, minLength: 8 });
    await expect(page.getByTestId('auth-status')).toHaveText('set (scub)');
    await expect(page.getByTestId('auth-hint')).toContainText('2 device(s) signed in');
  });

  test('the password form refuses a mismatch before it reaches the server', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Network' }).click();
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'authStatus', configured: false, user: '', sessions: 0, minLength: 8 } }));
    });

    await page.getByTestId('auth-edit').click();
    await page.locator('#auth-new').fill('scub-password-1');
    await page.locator('#auth-confirm').fill('scub-password-2');
    await page.getByTestId('auth-save').click();
    await expect(page.getByTestId('auth-result')).toContainText('do not match');

    // And a too-short one, which the server would reject anyway - saying so here costs
    // no round trip.
    await page.locator('#auth-new').fill('short');
    await page.locator('#auth-confirm').fill('short');
    await page.getByTestId('auth-save').click();
    await expect(page.getByTestId('auth-result')).toContainText('at least 8');
  });
});

test.describe('password reveal toggle', () => {
  test.beforeEach(async ({ page }) => {
    await waitForApp(page);
  });

  test('reveals and re-hides the login password without submitting the form', async ({ page }) => {
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'auth_required', required: true } }));
      // If the eye submitted, this is what would run - so its absence from the screen is
      // the proof it did not.
      window.argusLogin = async () => ({ ok: false, error: 'submitted by the eye' });
    });
    await expect(page.getByTestId('login-screen')).toBeVisible();
    await page.locator('#login-password').fill('scub-phone-pass');

    // Hidden by default: a field that opened revealed would show the password to whoever
    // is behind you, which is the opposite of what the toggle is for.
    await expect(page.locator('#login-password')).toHaveAttribute('type', 'password');

    await page.getByTestId('password-reveal').click();
    await expect(page.locator('#login-password')).toHaveAttribute('type', 'text');
    // The trap this test exists for: a <button> inside a <form> defaults to
    // type="submit", so the eye would fire a login attempt on every click.
    await expect(page.getByTestId('login-error')).toHaveCount(0);

    await page.getByTestId('password-reveal').click();
    await expect(page.locator('#login-password')).toHaveAttribute('type', 'password');
    await expect(page.locator('#login-password')).toHaveValue('scub-phone-pass');
  });

  test('the toggle stays centred when the font metrics change', async ({ page }) => {
    // Reported from a phone: centred on the desktop, visibly low there. A block wrapper
    // around an inline <input> carries the font's strut, so its line box - and therefore
    // the wrapper - grows with the device's metrics while the field does not, and a
    // button centred on the wrapper drifts. Measured: a tall font added 30px of wrapper
    // height under `display: block`. The invariant that kills the whole class of bug is
    // "wrapper height == input height", so that is what this asserts.
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'auth_required', required: true } }));
    });
    await expect(page.getByTestId('login-screen')).toBeVisible();

    const geometry = () => page.evaluate(() => {
      const input = document.querySelector('#login-password') as HTMLElement;
      const btn = document.querySelector('[data-testid="password-reveal"]') as HTMLElement;
      const wrap = input.parentElement as HTMLElement;
      const i = input.getBoundingClientRect(), b = btn.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      return {
        extra: Math.round(w.height - i.height),
        offBy: Math.round((b.y + b.height / 2) - (i.y + i.height / 2)),
      };
    });

    expect(await geometry()).toEqual({ extra: 0, offBy: 0 });

    // A font two sizes up with a tall line-height stands in for another device's metrics.
    await page.evaluate(() => {
      const form = document.querySelector('#login-password')!.closest('form') as HTMLElement;
      form.style.lineHeight = '3';
      form.style.fontSize = '22px';
    });
    expect(await geometry()).toEqual({ extra: 0, offBy: 0 });
  });

  test('each Settings field reveals on its own', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Network' }).click();
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'authStatus', configured: true, user: 'scub', sessions: 0, minLength: 8 } }));
    });
    await page.getByTestId('auth-edit').click();

    const eyes = page.getByTestId('password-reveal');
    await expect(eyes).toHaveCount(3);   // current, new, confirm
    await eyes.nth(1).click();

    // Visibility is per field, not shared: one toggle must not undress the others.
    await expect(page.locator('#auth-new')).toHaveAttribute('type', 'text');
    await expect(page.locator('#auth-current')).toHaveAttribute('type', 'password');
    await expect(page.locator('#auth-confirm')).toHaveAttribute('type', 'password');
  });
});

// The credential logic itself, on the compiled bundle: hashing, the current-password
// requirement and the lockout curve are pure and need neither a page nor a server.
test.describe('credential store', () => {
  const ROOT = path.resolve(__dirname, '..');
  const AUTH_JS = path.join(ROOT, 'out', 'backend', 'auth.js');
  const authFile = path.join(os.tmpdir(), `argus-spec-auth-${process.pid}.json`);
  let auth: typeof import('../src/backend/auth');

  test.beforeAll(() => {
    if (!fs.existsSync(AUTH_JS)) execSync('yarn compile', { cwd: ROOT, stdio: 'ignore' });
    // auth.ts resolves the path per call (authFilePath()), so this takes effect whenever
    // it is set - the earlier import-time constant made this order-dependent, and the
    // suite caught it by reading the developer's real credential instead of this one.
    process.env.ARGUS_AUTH_FILE = authFile;
    auth = require(AUTH_JS);
  });

  test.beforeEach(() => {
    try { fs.unlinkSync(authFile); } catch { /* not there */ }
    auth.resetAuthState();
  });

  test.afterAll(() => {
    try { fs.unlinkSync(authFile); } catch { /* not there */ }
  });

  test('stores a salted hash and never the password', () => {
    expect(auth.setPassword('scub', 'scub-password-1').ok).toBe(true);
    const raw = fs.readFileSync(authFile, 'utf8');
    expect(raw).not.toContain('scub-password-1');
    const stored = JSON.parse(raw);
    expect(stored.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.hash).toMatch(/^[0-9a-f]+$/);

    expect(auth.verifyPassword('scub', 'scub-password-1')).toBe(true);
    expect(auth.verifyPassword('scub', 'scub-password-2')).toBe(false);
    expect(auth.verifyPassword('someone-else', 'scub-password-1')).toBe(false);
  });

  test('refuses every remote client when nothing is configured', () => {
    // The strict default: "no password" must mean closed, not open. A verify that
    // returned true for an unconfigured server would open the door to everyone.
    expect(auth.hasPassword()).toBe(false);
    expect(auth.verifyPassword('', '')).toBe(false);
    expect(auth.verifyPassword('scub', 'anything')).toBe(false);
  });

  test('changing the password requires the current one', () => {
    auth.setPassword('scub', 'scub-password-1');
    expect(auth.setPassword('scub', 'scub-password-3', 'wrong').ok).toBe(false);
    expect(auth.verifyPassword('scub', 'scub-password-1')).toBe(true);   // unchanged
    expect(auth.setPassword('scub', 'scub-password-3', 'scub-password-1').ok).toBe(true);
    expect(auth.verifyPassword('scub', 'scub-password-3')).toBe(true);
  });

  test('a password change invalidates every issued session', () => {
    auth.setPassword('scub', 'scub-password-1');
    const token = auth.createSession('192.168.0.12');
    expect(auth.isValidSession(token)).toBe(true);
    auth.setPassword('scub', 'scub-password-3', 'scub-password-1');
    expect(auth.isValidSession(token)).toBe(false);
  });

  test('locks an address out after repeated failures and backs off', () => {
    const addr = '192.168.0.12';
    for (let i = 0; i < 4; i++) auth.noteLoginFailure(addr, 1000);
    // Four is still under the limit: a fat-fingered password must not lock you out.
    expect(auth.checkRateLimit(addr, 1000).allowed).toBe(true);

    auth.noteLoginFailure(addr, 1000);
    const first = auth.checkRateLimit(addr, 1000);
    expect(first.allowed).toBe(false);
    expect(first.retryAfterMs).toBe(30_000);

    auth.noteLoginFailure(addr, 1000);
    expect(auth.checkRateLimit(addr, 1000).retryAfterMs).toBe(60_000);   // doubles

    // The lockout expires on its own rather than needing an unlock.
    expect(auth.checkRateLimit(addr, 1000 + 60_001).allowed).toBe(true);
    // A success wipes the record, so an honest user is never carrying old failures.
    auth.noteLoginSuccess(addr);
    expect(auth.checkRateLimit(addr, 1000).allowed).toBe(true);
  });
});
