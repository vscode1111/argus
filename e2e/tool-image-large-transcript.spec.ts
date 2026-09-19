import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Reported: clicking an image preview took 3-5s and felt slow. The transcript behind
// the report is 336 MB (heavy CDP screenshot use - each screenshot is a base64
// tool_result line), and readToolImage() decoded the WHOLE file to a UTF-8 string
// before searching it - measured at ~1.1s of a ~1.36s total on that real file, most
// of it spent decoding bytes the search almost never needed. Driven here on the
// compiled bundle against a synthetic fixture shaped the same way (many big base64
// "screenshot" lines, target near the end, some Cyrillic prose mixed in - the real
// transcript's content is not ASCII-only either) rather than the reporter's own
// 336 MB session, so the suite does not depend on a file that only exists on one
// machine; the shape (big base64 lines, non-ASCII content, match near EOF) is what
// makes the old implementation slow, not this specific file.
//
// The threshold is calibrated, not guessed: on this fixture the pre-fix
// implementation (readFileSync(file,'utf8') + split) measured 362-523ms across 5
// runs, and the fix (byte-level Buffer scan, decoding only the matched line) measured
// 73-120ms - see the calibration numbers this threshold sits between.

const ROOT = path.resolve(__dirname, '..');
const SESSIONS_JS = path.join(ROOT, 'out', 'backend', 'sessions.js');

type SessionsModule = {
  scanTranscriptForImage(file: string, toolUseId: string): { data: string; mediaType: string } | null;
};

let mod: SessionsModule;
let fixture: string;
const TOOL_USE_ID = 'toolu_01scubLargeTranscriptTarget';
const FIXTURE_MB = 100;
// Comfortably between the pre-fix (362-523ms measured) and post-fix (73-120ms
// measured) ranges on this fixture shape.
const MAX_MS = 250;

function imageBase64(sizeBytes: number): string {
  return Buffer.alloc(sizeBytes, 'A').toString('base64').slice(0, sizeBytes);
}

// Builds a transcript shaped like the reported one: many "screenshot" tool_result
// lines (big base64 payloads, some non-ASCII prose alongside them - real transcripts
// are not ASCII-only), with the target tool call's own image placed near the very
// end, matching the reported case (97.9% through the real 336 MB file).
function buildFixture(file: string, targetMb: number): void {
  const filler = imageBase64(90_000);
  const prose = 'Скриншот формы объявления на Авито сохранён и прочитан агентом. ';
  const toolUseLine = (id: string) => JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_' + id, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'C:/tmp/shot.png' } }] },
  });
  const toolResultLine = (id: string, isTarget: boolean) => JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: isTarget
          ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: filler } }]
          : [{ type: 'text', text: prose + filler.slice(0, 20_000) }],
      }],
    },
  });

  const fd = fs.openSync(file, 'w');
  try {
    const targetBytes = targetMb * 1024 * 1024;
    let bytes = 0;
    let n = 0;
    while (bytes < targetBytes) {
      n++;
      const id = 'toolu_01scubFiller' + String(n).padStart(8, '0');
      const chunk = toolUseLine(id) + '\n' + toolResultLine(id, false) + '\n';
      fs.writeSync(fd, chunk);
      bytes += Buffer.byteLength(chunk);
    }
    fs.writeSync(fd, toolUseLine(TOOL_USE_ID) + '\n');
    fs.writeSync(fd, toolResultLine(TOOL_USE_ID, true) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

test.beforeAll(() => {
  if (!fs.existsSync(SESSIONS_JS)) execSync('npx tsc -p ./', { cwd: ROOT, stdio: 'inherit' });
  mod = require(SESSIONS_JS) as SessionsModule;
  fixture = path.join(os.tmpdir(), `argus-scub-large-transcript-${Date.now()}.jsonl`);
  buildFixture(fixture, FIXTURE_MB);
});

test.afterAll(() => {
  try { fs.unlinkSync(fixture); } catch { /* already gone */ }
});

test.describe('image preview on a large transcript', () => {
  test('finds the image and does not re-decode the whole file to do it', () => {
    const start = process.hrtime.bigint();
    const img = mod.scanTranscriptForImage(fixture, TOOL_USE_ID);
    const tookMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(img).not.toBeNull();
    expect(img!.mediaType).toBe('image/png');
    // Not just "found something" - found the actual target payload, not a filler line.
    expect(img!.data.length).toBe(90_000);

    // The regression: a build that reads the whole file as a UTF-8 string before
    // searching it takes 362-523ms on this fixture (measured); this must not.
    expect(tookMs).toBeLessThan(MAX_MS);
  });

  test('a tool_use_id with no matching tool_result returns null promptly', () => {
    const start = process.hrtime.bigint();
    const img = mod.scanTranscriptForImage(fixture, 'toolu_01scubDoesNotExist00000');
    const tookMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(img).toBeNull();
    // The control: a build that fell back to scanning every line for a miss (instead
    // of Buffer.indexOf returning -1 immediately) would still be slow here even after
    // the fix above passes, since this id never occurs at all.
    expect(tookMs).toBeLessThan(MAX_MS);
  });
});
