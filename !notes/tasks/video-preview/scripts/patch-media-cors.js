// Lets the failure-diagnosis HEAD probe read its own answer cross-origin.
//
// The probe exists to tell "the link expired" (404) from "no decoder" (200 + a file the
// browser cannot decode). Under Vite the page is on :5173 and the server on :3001, so
// without CORS the fetch throws and EVERY failure is reported as "the server could not
// be reached" - which the integration spec caught against a file the server had just
// served happily.
//
// The 404 and 401 branches need it just as much as the success one: a status a script
// cannot read is no better than no status at all, and 404 is precisely the case this was
// built for. HEAD only, so a script learns the status and never the bytes.
const fs = require('fs');

const ROOT = 'd:/_Projects/scub111g/argus/';
let failures = 0;

function patch(file, from, to, label) {
  const full = ROOT + file;
  const src = fs.readFileSync(full, 'utf-8');
  const crlf = /\r\n/.test(src);
  const needle = crlf ? from.split('\n').join('\r\n') : from;
  const n = src.split(needle).length - 1;
  if (n !== 1) {
    console.error(`FAIL (${n} matches): ${label}`);
    failures++;
    return;
  }
  fs.writeFileSync(full, src.replace(needle, crlf ? to.split('\n').join('\r\n') : to));
  console.log(`ok: ${label}`);
}

// serveMedia takes the extra headers and merges them into every response it writes.
patch(
  'src/backend/media.ts',
  `export function serveMedia(req: IncomingMessage, res: ServerResponse, grant: MediaGrant): void {
  let size: number;
  try {
    size = statSync(grant.path).size;
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('media file is gone');
    return;
  }

  const range = parseRange(req.headers.range, size);
  if (range === null) {
    res.writeHead(416, { 'Content-Range': \`bytes */\${size}\`, 'Accept-Ranges': 'bytes' });
    res.end();
    return;
  }

  const head: Record<string, string> = {`,
  `export function serveMedia(
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
    res.writeHead(416, { 'Content-Range': \`bytes */\${size}\`, 'Accept-Ranges': 'bytes', ...extraHeaders });
    res.end();
    return;
  }

  const head: Record<string, string> = {
    ...extraHeaders,`,
  'serveMedia accepts extra headers',
);

// The two early exits in the route, which the probe must be able to read.
patch(
  'src/backend/index.ts',
  `    if (urlPath.startsWith('/media/')) {
      if (!local && !isValidSession(query.get('auth'))) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('authentication required');
        return;
      }
      const grant = lookupGrant(urlPath.slice('/media/'.length));
      if (!grant) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('unknown or expired media token');
        return;
      }`,
  `    if (urlPath.startsWith('/media/')) {
      // HEAD only - see the note below on why the probe needs to read these statuses.
      const mediaCors = req.method === 'HEAD' ? corsHeaders(req) : {};
      if (!local && !isValidSession(query.get('auth'))) {
        res.writeHead(401, { 'Content-Type': 'text/plain', ...mediaCors });
        res.end('authentication required');
        return;
      }
      const grant = lookupGrant(urlPath.slice('/media/'.length));
      if (!grant) {
        // The common failure, not an exotic one: grants live in this process's memory,
        // so a daemon that idle-exits invalidates every preview link still on screen.
        // The card says "expired" rather than blaming the codec only because it can
        // read THIS status, which cross-origin means only with the header above.
        res.writeHead(404, { 'Content-Type': 'text/plain', ...mediaCors });
        res.end('unknown or expired media token');
        return;
      }`,
  'media route 401/404 carry CORS for HEAD',
);

// Drop the now-duplicated const introduced by the earlier edit.
patch(
  'src/backend/index.ts',
  `      const cors = req.method === 'HEAD' ? corsHeaders(req) : {};
      serveMedia(req, res, grant, cors);`,
  `      serveMedia(req, res, grant, mediaCors);`,
  'reuse the single cors binding',
);

process.exit(failures ? 1 : 0);
