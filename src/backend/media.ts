import { createReadStream, statSync } from 'fs';
import { randomBytes } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Media playback: capability tokens plus HTTP range streaming.
 *
 * Video does not go over the WebSocket. A 21.5MB .mp4 read as text became a **51MB**
 * frame (measured), nothing was playable until all of it landed, and seeking was
 * impossible - the whole file had to arrive to watch the last second of it. A range
 * endpoint hands the browser its own native player instead: it fetches what it plays,
 * a seek costs one small request, and nothing is buffered in this process.
 *
 * The HTTP layer deliberately takes **no path**. `src/backend/index.ts` keeps a fixed
 * static allowlist precisely so there is no arbitrary-path read over HTTP, and a
 * `?path=` media route would have reversed that. Instead the path is validated once on
 * the WebSocket - which is already authenticated and origin-checked - and exchanged for
 * an opaque token; `/media/<token>` can only ever serve a file some client was already
 * allowed to preview. Traversal is not defended against here, it is unrepresentable.
 */

export type MediaKind = 'video' | 'audio';

export interface MediaGrant {
  path: string;
  kind: MediaKind;
  mediaType: string;
  size: number;
  expiresAt: number;
}

/**
 * How long a grant lives without being touched. Long enough to leave a video paused
 * over lunch and still scrub it afterwards; the expiry slides on every request, so an
 * hour-long file being watched through never goes stale mid-playback.
 */
const GRANT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cap on live grants. A long session browsing a media folder would otherwise grow this
 * map for the life of the daemon. Oldest-first eviction: the one being watched is also
 * the one being refreshed, so it is never the one dropped.
 */
const MAX_GRANTS = 200;

const grants = new Map<string, MediaGrant>();

function sweep(now: number): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
  while (grants.size > MAX_GRANTS) {
    const oldest = grants.keys().next();
    if (oldest.done) break;
    grants.delete(oldest.value);
  }
}

/**
 * Mint (or reuse) a token for an already-validated absolute path. Reused because
 * reopening the same video should not leak a fresh token per click, and because the
 * browser then keeps whatever it had already buffered under that URL.
 */
export function grantMedia(path: string, kind: MediaKind, mediaType: string, size: number): string {
  const now = Date.now();
  sweep(now);
  for (const [token, grant] of grants) {
    if (grant.path === path) {
      grant.expiresAt = now + GRANT_TTL_MS;
      grant.size = size;
      return token;
    }
  }
  const token = randomBytes(24).toString('base64url');
  grants.set(token, { path, kind, mediaType, size, expiresAt: now + GRANT_TTL_MS });
  return token;
}

/** The grant behind a token, or undefined when it never existed or has expired. */
export function lookupGrant(token: string): MediaGrant | undefined {
  const grant = grants.get(token);
  if (!grant) return undefined;
  const now = Date.now();
  if (grant.expiresAt <= now) {
    grants.delete(token);
    return undefined;
  }
  // Sliding expiry: a file being played is a file still in use.
  grant.expiresAt = now + GRANT_TTL_MS;
  return grant;
}

/** Drop every grant. Exported for tests, which must not leak state between cases. */
export function clearGrants(): void {
  grants.clear();
}

/** Live grant count, for tests asserting reuse and eviction rather than guessing. */
export function grantCount(): number {
  return grants.size;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range: bytes=...` header against a known size.
 *
 * Returns undefined when there is no range to honour (absent or syntactically not a
 * byte range - both mean "send the whole thing"), and null when the range is real but
 * unsatisfiable, which is a 416 rather than a silent full-body reply.
 *
 * Multi-range requests are deliberately answered with the whole file: no browser media
 * element issues one, and multipart/byteranges is a lot of surface for nobody.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | undefined | null {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return undefined;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // `bytes=-500`: the last 500 bytes. Asking for more than exists is the whole file.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  // An empty file has no satisfiable range at all, so start 0 is already past its end.
  if (start >= size || start > end) return null;
  return { start, end };
}

/**
 * Serve one grant, honouring Range. The file is re-stat'd per request rather than
 * trusting the size recorded at grant time - the agent may have rewritten it since,
 * and a stale Content-Length is how a player ends up stalling at the end of a file.
 */
export function serveMedia(
  req: IncomingMessage,
  res: ServerResponse,
  grant: MediaGrant,
  extraHeaders: Record<string, string> = {},
): void {
  let size: number;
  try {
    size = statSync(grant.path).size;
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain', ...extraHeaders });
    res.end('media file is gone');
    return;
  }

  const range = parseRange(req.headers.range, size);
  if (range === null) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', ...extraHeaders });
    res.end();
    return;
  }

  const head: Record<string, string> = {
    ...extraHeaders,
    'Content-Type': grant.mediaType,
    'Accept-Ranges': 'bytes',
    // The bytes are a local file that can change under us, and the URL is a one-off
    // token, so there is nothing worth a shared cache holding on to.
    'Cache-Control': 'no-store',
  };

  if (range) {
    head['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    head['Content-Length'] = String(range.end - range.start + 1);
  } else {
    head['Content-Length'] = String(size);
  }

  res.writeHead(range ? 206 : 200, head);

  // A HEAD probe (some players issue one before deciding how to fetch) wants the
  // headers above and nothing else.
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = range
    ? createReadStream(grant.path, { start: range.start, end: range.end })
    : createReadStream(grant.path);
  // A seek aborts the in-flight response; destroying the stream on close is what stops
  // one abandoned read per scrub piling up for the life of the process.
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}
