import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Deep-link tests (?session=<id> in the page URL): opening a session by URL
// attaches to its live entry at upgrade time (no click, no empty replay), falls
// back to a disk replay for finished sessions, resolves the workspace from the
// session id server-side (so ?dir= is optional and a stale ?dir= is overridden),
// and rejects malformed ids without touching the filesystem.
//
// Uses the real dev server on :3001 via the Vite page on :5173. Each test uses a
// unique temp dir; synthetic transcripts are cleaned from ~/.claude/projects.

// Replicates the CLI's project-folder encoding (see src/backend/sessions.ts).
function encodeDir(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function projectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeDir(cwd));
}

const cleanupPaths: string[] = [];

function makeTempDir(tag: string): string {
  const dir = path.join(os.tmpdir(), `argus-deeplink-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  cleanupPaths.push(dir, projectDir(dir));
  return dir;
}

test.afterAll(() => {
  for (const p of cleanupPaths.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
});

// Like waitForApp() but with a query string (deep links need URL params).
async function openApp(page: Page, query: string): Promise<void> {
  const placeholder = page.getByPlaceholder('Ask Argus');
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt === 1) {
      await page.goto('/' + query, { waitUntil: 'domcontentloaded' });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    try {
      await expect(placeholder).toBeVisible({ timeout: 10_000 });
      return;
    } catch {
      if (attempt === MAX_ATTEMPTS) throw new Error(`App failed to mount after ${MAX_ATTEMPTS} attempts`);
    }
  }
}

// Poll the CLI's project folder for the transcript of a fresh temp workspace.
// Waits until the file also carries a `cwd` record, which is what the server's
// findWorkspaceForSession needs to resolve the deep link.
async function waitForSessionId(cwd: string, timeoutMs = 45_000): Promise<string> {
  const dir = projectDir(cwd);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const hit = fs.readdirSync(dir).find(f => /^[0-9a-f-]{36}\.jsonl$/.test(f));
      if (hit && fs.readFileSync(path.join(dir, hit), 'utf8').includes('"cwd"')) {
        return hit.slice(0, -'.jsonl'.length);
      }
    } catch { /* folder not created yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`transcript never appeared for ${cwd}`);
}

// Write a finished-session transcript directly (no CLI involved), the way the
// CLI persists it, so disk-replay and workspace-resolution paths are deterministic.
function writeSyntheticTranscript(cwd: string, userText: string, assistantText: string): string {
  const id = randomUUID();
  const pdir = projectDir(cwd);
  fs.mkdirSync(pdir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', cwd, session_id: id }),
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: userText } }),
    JSON.stringify({ type: 'assistant', message: { id: 'scub-m1', content: [{ type: 'text', text: assistantText }] } }),
  ];
  fs.writeFileSync(path.join(pdir, id + '.jsonl'), lines.join('\n') + '\n');
  return id;
}

test('deep link attaches to the live turn without any click; stop from the linked page ends it for both', async ({ browser }) => {
  const dir = makeTempDir('live');
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  try {
    await openApp(pageA, `?dir=${encodeURIComponent(dir)}`);
    const prompt = 'scub-essay: write a 1000-word story about a lighthouse keeper. Do not use any tools.';
    await pageA.getByPlaceholder('Ask Argus').fill(prompt);
    await pageA.getByRole('button', { name: 'Send' }).click();
    await expect(pageA.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });
    const id = await waitForSessionId(dir);

    await openApp(pageB, `?dir=${encodeURIComponent(dir)}&session=${id}`);
    const stopA = pageA.getByRole('button', { name: 'Stop' });
    const stopB = pageB.getByRole('button', { name: 'Stop' });

    // The attached entry replays its history: A's prompt must be visible on B
    // whether the turn is still streaming or already finished.
    await expect(pageB.getByText('scub-essay').first()).toBeVisible({ timeout: 15_000 });

    // Gate on app-owned state: if the turn is still live on A, B must be live too
    // (Stop rendered with no click), and stopping from B ends the turn on both.
    if (await stopA.isVisible()) {
      await expect(stopB).toBeVisible({ timeout: 10_000 });
      await stopB.click();
      await expect(stopA).toBeHidden({ timeout: 20_000 });
      await expect(stopB).toBeHidden({ timeout: 20_000 });
    } else {
      // Turn finished before B mounted: the replay must not present as streaming.
      await expect(stopB).toBeHidden();
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test('deep link with no ?dir= resolves the workspace server-side and replays a finished session from disk', async ({ page }) => {
  const dir = makeTempDir('resolve');
  const id = writeSyntheticTranscript(dir, 'scub-deep-link-past', 'scub-past-reply');

  await openApp(page, `?session=${id}`);
  await expect(page.getByText('scub-deep-link-past')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('scub-past-reply')).toBeVisible();
  // Not live: the replay must not present as a streaming turn.
  await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
  // The header workspace tile shows the session's real project name.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toHaveText(path.basename(dir), { timeout: 15_000 });
});

test('a new chat puts its assigned session id into the page URL', async ({ page }) => {
  // The CLI mints the id server-side, so nothing the user clicked carries it. Without
  // the sessionId push the address bar stayed bare and a fresh chat could not be
  // shared or reloaded back into.
  const dir = makeTempDir('newurl');
  await openApp(page, `?dir=${encodeURIComponent(dir)}`);
  expect(new URL(page.url()).searchParams.get('session')).toBeNull();

  await page.getByPlaceholder('Ask Argus').fill('Reply with just "OK".');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect.poll(
    () => new URL(page.url()).searchParams.get('session'),
    { timeout: 30_000 },
  ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  // The id in the URL is the real one: the page reloads straight back into the chat.
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 60_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Reply with just "OK".')).toBeVisible({ timeout: 15_000 });
});

test('reloading a deep-linked finished session replays it again', async ({ page }) => {
  // Regression: the first load leaves an entry bound to the session but with an empty
  // in-memory history (the transcript was read from disk, never streamed). The reload
  // re-attached to that entry and replayed the empty history, blanking the page.
  const dir = makeTempDir('reload');
  const id = writeSyntheticTranscript(dir, 'scub-reload-prompt', 'scub-reload-reply');

  await openApp(page, `?session=${id}`);
  await expect(page.getByText('scub-reload-prompt')).toBeVisible({ timeout: 15_000 });

  // Well inside the 30s grace window, so the first load's entry is still alive.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('scub-reload-prompt')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('scub-reload-reply')).toBeVisible();
});

test('deep link with a stale ?dir= ends up in the session\'s real workspace', async ({ page }) => {
  const realDir = makeTempDir('real');
  const staleDir = makeTempDir('stale');
  const id = writeSyntheticTranscript(realDir, 'scub-stale-dir-check', 'scub-stale-reply');

  await openApp(page, `?dir=${encodeURIComponent(staleDir)}&session=${id}`);
  const tile = page.getByRole('button', { name: 'Switch workspace' });
  // The tile settles on the session's workspace, never on the stale ?dir=.
  await expect(tile).toHaveText(path.basename(realDir), { timeout: 15_000 });
  await expect(page.getByText('scub-stale-dir-check')).toBeVisible();
});

test('malformed session id is rejected and the connection falls back to ?dir=', async ({ page }) => {
  const dir = makeTempDir('malformed');
  await openApp(page, `?dir=${encodeURIComponent(dir)}&session=${encodeURIComponent('../../etc/passwd')}`);
  // The app works normally on the ?dir= workspace; the bad id was dropped.
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toHaveText(path.basename(dir), { timeout: 15_000 });
  await expect(page.getByPlaceholder('Ask Argus')).toBeEnabled();
});
