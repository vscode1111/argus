// Does the 1000-entry cap hold, and what does a huge folder cost?
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFilePreview } from '../../../../src/backend/filePreview';

const big = path.join(os.tmpdir(), 'argus-dir-preview-probe');
fs.rmSync(big, { recursive: true, force: true });
fs.mkdirSync(big, { recursive: true });
for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(4, '0')}.txt`), 'x'.repeat(i));
for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(big, `d${String(i).padStart(3, '0')}`));

const t0 = Date.now();
const r = readFilePreview(big, big);
console.log('entries =', r.entries?.length, '| truncated =', r.truncated, '| ms =', Date.now() - t0);
console.log('first 3 =', r.entries?.slice(0, 3).map(e => `${e.isDir ? '[D]' : ''}${e.name}`));
console.log('last  1 =', r.entries?.[r.entries.length - 1]?.name, '| size present:', r.entries?.[r.entries.length - 1]?.size);
console.log('total on disk =', fs.readdirSync(big).length, '=> shown + truncated =', (r.entries?.length ?? 0) + (r.truncated ?? 0));

const empty = path.join(big, 'd000');
console.log('empty dir  =', JSON.stringify(readFilePreview(empty, big).entries));
fs.rmSync(big, { recursive: true, force: true });
