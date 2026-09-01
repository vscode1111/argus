// Can the image the user could not see be recovered from the transcript by tool id,
// now that the file it was read from no longer exists?
const path = require('path');
const fs = require('fs');
const { readToolImage } = require(path.resolve('out/backend/sessions.js'));

const SESSION = '7ac16cc8-59bd-4540-ba46-f4b9a50f2815';
const WS = 'd:\\_Projects\\scub111g\\estate-agent';
// The Read the user clicked (screenshot 2), plus guards.
const CASES = [
  ['toolu_012aMVJaRisb1uw7eWpjaryf', 'the reported image Read'],
  ['toolu_01RXZQC3C8tJEuQiiKuoAHs9', 'a text Read (must be null)'],
  ['toolu_notarealid', 'unknown id (must be null)'],
  ['../../../etc/passwd', 'traversal-shaped id (must be null)'],
];

for (const [id, label] of CASES) {
  const t0 = Date.now();
  const img = readToolImage(SESSION, WS, id);
  const ms = Date.now() - t0;
  if (!img) { console.log(`${label}: null (${ms}ms)`); continue; }
  const bytes = Buffer.from(img.data, 'base64');
  const out = path.resolve('!notes/tasks/image-preview-from-tool-result/scripts/recovered.jpg');
  fs.writeFileSync(out, bytes);
  console.log(`${label}: ${img.mediaType}, ${(bytes.length / 1024).toFixed(0)} KB in ${ms}ms`);
  console.log(`  jpeg magic=${bytes.slice(0, 3).toString('hex')} (ffd8ff expected) -> ${out}`);
}
