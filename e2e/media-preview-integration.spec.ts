import { test, expect } from '@playwright/test';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Video and audio against the real server: the grant round trip, the HTTP range
 * endpoint behind it, and a real browser actually decoding what comes back.
 *
 * The defect this replaces is the reason for every size assertion here. Everything that
 * was not a directory or an image used to be read with `readFileSync(path, 'utf-8')`, so
 * clicking a 21.5MB .mp4 sent a **51MB** WebSocket frame holding 21.4M characters of
 * replacement garbage across 87,580 "lines" - which the panel then tried to syntax
 * highlight. So the first thing worth pinning is a negative: the bytes must not be on
 * the wire at all.
 *
 * A fixture WAV is synthesized rather than committed. There is no ffmpeg here and a real
 * video is megabytes, but a WAV is 44 bytes of header plus samples - which makes it the
 * one media file that can be written by hand and still genuinely decode in Chrome, so it
 * carries the "it really plays" half. The fake .mp4 carries the opposite half: a media
 * extension with no valid stream behind it, the same path a real .mkv with no codec
 * takes, and its bytes are deterministic so a range response can be checked exactly.
 *
 * ARGUS_E2E_PORT points the suite at a throwaway backend instead of a dev server in use.
 */

const PORT = process.env.ARGUS_E2E_PORT ?? '3001';
const BACKEND = `http://localhost:${PORT}`;

interface MediaGrant {
  type: string;
  path: string;
  token?: string;
  kind?: string;
  mediaType?: string;
  size?: number;
  port?: number;
  error?: string;
}

let workspace: string;
let wavPath: string;
let mp4Path: string;
let binPath: string;
let txtPath: string;

/** A real, decodable WAV: `seconds` of a tone, 8-bit mono at 8 kHz. */
function writeWav(file: string, seconds: number, hz: number): void {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) {
    buf[44 + i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * hz * i) / rate));
  }
  fs.writeFileSync(file, buf);
}

test.beforeAll(() => {
  workspace = path.join(os.tmpdir(), `argus-media-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(workspace, { recursive: true });

  wavPath = path.join(workspace, 'scub-tone.wav');
  writeWav(wavPath, 3, 440);

  // Deterministic filler behind a real ftyp box: undecodable, but every byte predictable.
  mp4Path = path.join(workspace, 'scub-clip.mp4');
  const mp4 = Buffer.alloc(64 * 1024);
  mp4.write('    ftypisom', 0, 'binary');
  for (let i = 16; i < mp4.length; i++) mp4[i] = i % 251;
  fs.writeFileSync(mp4Path, mp4);

  // A non-media binary, and the text control that stops "call everything binary" passing.
  binPath = path.join(workspace, 'scub-blob.bin');
  const bin = Buffer.alloc(9000);
  for (let i = 0; i < bin.length; i++) bin[i] = i % 256;
  fs.writeFileSync(binPath, bin);

  txtPath = path.join(workspace, 'scub-plain.txt');
  fs.writeFileSync(txtPath, 'scub plain text fixture\n'.repeat(40), 'utf-8');
});

test.afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function getNonce(): Promise<string> {
  const res = await fetch(`${BACKEND}/nonce`);
  return (await res.text()).trim();
}

/**
 * A client that buffers every frame from construction. A reply the server writes in the
 * same tick as another can share one TCP read and be emitted before a listener attached
 * after `open` exists, which shows up as an intermittent timeout rather than as a bug.
 */
function openClient(nonce: string, dir: string): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const url = `ws://localhost:${PORT}/agent?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(dir)}&client=browser`;
    const ws = new WebSocket(url, { origin: 'http://localhost:5173' });
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (data) => {
      try { frames.push(JSON.parse(String(data))); } catch { /* binary */ }
    });
    ws.on('open', () => resolve({ ws, frames }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade failed: ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

/** Ask for a grant and consume the reply out of the buffer. */
async function requestGrant(
  ws: WebSocket,
  frames: Record<string, unknown>[],
  filePath: string,
): Promise<{ grant: MediaGrant; frameBytes: number }> {
  ws.send(JSON.stringify({ type: 'mediaUrl', path: filePath }));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const i = frames.findIndex((f) => f.type === 'mediaGrant');
    if (i >= 0) {
      const [grant] = frames.splice(i, 1);
      return { grant: grant as unknown as MediaGrant, frameBytes: JSON.stringify(grant).length };
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('no mediaGrant frame within 10s');
}

test.describe('media grant and range streaming', () => {
  test('a grant carries no bytes, and the endpoint serves real ranges', async () => {
    const nonce = await getNonce();
    const { ws, frames } = await openClient(nonce, workspace);
    try {
      const size = fs.statSync(mp4Path).size;
      const { grant, frameBytes } = await requestGrant(ws, frames, mp4Path);

      expect(grant.token, 'grant must carry a token').toBeTruthy();
      expect(grant.kind).toBe('video');
      expect(grant.mediaType).toBe('video/mp4');
      expect(grant.size).toBe(size);

      // The whole point. 64KB of file would be ~150KB of UTF-8-mangled JSON on the old
      // path; the grant is a few hundred bytes and does not grow with the file.
      expect(frameBytes, 'the grant frame must not carry the media').toBeLessThan(600);

      const url = `${BACKEND}/media/${encodeURIComponent(grant.token!)}`;

      const full = await fetch(url);
      expect(full.status).toBe(200);
      expect(full.headers.get('accept-ranges')).toBe('bytes');
      expect(Number(full.headers.get('content-length'))).toBe(size);

      // A length-correct response from the wrong offset looks perfect in headers and
      // plays as a corrupt file, so compare the bytes themselves.
      const start = 20_000;
      const end = start + 999;
      const part = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe(`bytes ${start}-${end}/${size}`);
      const got = Buffer.from(await part.arrayBuffer());
      expect(got.length).toBe(1000);
      const expected = Buffer.alloc(1000);
      const fd = fs.openSync(mp4Path, 'r');
      fs.readSync(fd, expected, 0, 1000, start);
      fs.closeSync(fd);
      expect(got.equals(expected), 'range bytes must match the file at that offset').toBe(true);

      // The suffix form, used to find an MP4 moov atom at the tail.
      const suffix = await fetch(url, { headers: { Range: 'bytes=-500' } });
      expect(suffix.status).toBe(206);
      expect((await suffix.arrayBuffer()).byteLength).toBe(500);

      // Unsatisfiable must be 416, never a silent full body.
      const past = await fetch(url, { headers: { Range: `bytes=${size + 10}-${size + 20}` } });
      expect(past.status).toBe(416);

      // A token nobody minted.
      const unknown = await fetch(`${BACKEND}/media/scubNotARealToken`);
      expect(unknown.status).toBe(404);

      // Reuse, so reopening the same file does not mint a token per click.
      const second = await requestGrant(ws, frames, mp4Path);
      expect(second.grant.token).toBe(grant.token);
    } finally {
      ws.close();
    }
  });

  test('a non-media binary is described, and plain text still renders', async () => {
    const nonce = await getNonce();
    const { ws, frames } = await openClient(nonce, workspace);
    try {
      const read = async (filePath: string) => {
        ws.send(JSON.stringify({ type: 'readFilePreview', path: filePath }));
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const i = frames.findIndex((f) => f.type === 'filePreview');
          if (i >= 0) return frames.splice(i, 1)[0] as Record<string, unknown>;
          await new Promise((r) => setTimeout(r, 40));
        }
        throw new Error('no filePreview frame within 10s');
      };

      const bin = await read(binPath);
      expect(bin.binary, 'a binary must be reported, not decoded').toBeTruthy();
      expect((bin.binary as { size: number }).size).toBe(fs.statSync(binPath).size);
      expect(bin.content).toBe('');

      // The control. Without it, a guard that called everything binary would pass above.
      const txt = await read(txtPath);
      expect(txt.binary).toBeUndefined();
      expect(String(txt.content)).toContain('scub plain text fixture');
    } finally {
      ws.close();
    }
  });
});

test.describe('the player in a real browser', () => {
  test('a real audio file is granted, decoded and played', async ({ page }) => {
    await page.goto(`/?dir=${encodeURIComponent(workspace)}&file=${encodeURIComponent(wavPath)}`, {
      waitUntil: 'domcontentloaded',
    });

    const player = page.locator('[data-testid="media-player"]');
    await expect(player).toBeVisible({ timeout: 15_000 });
    // <audio>, not <video>: a build that always rendered a video element would pass
    // every other assertion here.
    await expect(page.locator('audio')).toHaveCount(1);
    await expect(page.locator('video')).toHaveCount(0);

    const played = await page.evaluate(async () => {
      const a = document.querySelector('audio') as HTMLAudioElement;
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 80 && a.readyState < 1; i++) await wait(100);
      const before = a.currentTime;
      a.muted = true;
      try { await a.play(); } catch { /* reported below via advanced */ }
      await wait(800);
      return {
        duration: a.duration,
        error: a.error ? a.error.code : null,
        advanced: a.currentTime > before,
        src: a.currentSrc,
      };
    });

    expect(played.error, 'the browser must decode the fixture').toBeNull();
    expect(played.duration).toBeCloseTo(3, 1);
    expect(played.advanced, 'playback must actually advance').toBe(true);
    expect(played.src).toContain('/media/');

    // Nothing text-like may have been rendered for media.
    await expect(page.locator('[data-line]')).toHaveCount(0);
  });

  test('media the browser cannot decode falls back to a readable card', async ({ page }) => {
    await page.goto(`/?dir=${encodeURIComponent(workspace)}&file=${encodeURIComponent(mp4Path)}`, {
      waitUntil: 'domcontentloaded',
    });

    // The fixture has a media extension and no decodable stream, which is what a real
    // .mkv with an unsupported codec does: it fails at load, not at grant time.
    const card = page.locator('[data-testid="media-unsupported"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText('cannot be played here');
    await expect(card).toContainText('64 KB');
    await expect(page.locator('[data-testid="preview-loading"]')).toHaveCount(0);
    await expect(page.locator('[data-line]')).toHaveCount(0);
  });
});
