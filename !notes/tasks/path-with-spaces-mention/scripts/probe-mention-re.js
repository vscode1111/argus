// Candidate rules for MENTION_RE, which currently stops at the first space and so
// highlights only "@Бискуб" of "@Бискуб Константин Николаевич/Военный билет/... 12.jpg".
// No markdown parser is involved on either surface that uses it (the input overlay and the
// user bubble both render raw text), so a pure regex probe is valid evidence here.

const CURRENT = /(?<=^|\s)@\S+/g;

// B: extension-anchored, end-of-line fallback. KILLED: the fallback fires for every
// mention without an extension, so a plain handle swallows the rest of the sentence.
const B = /(?<=^|\s)@(?:[^\s\n]+ )*?[^\s\n]*\.[\p{L}\d]+(?![\p{L}\d])|(?<=^|\s)@[^\n]*/gu;

// B': extension-anchored, but falls back to the CURRENT \S+ rule instead of end-of-line,
// and the space-crossing branch requires a separator in the run.
const B2 = /(?<=^|\s)@(?:[^\s\n\\/]+ )*?[^\s\n]*[\\/][^\s\n]*\.[\p{L}\d]+(?![\p{L}\d])|(?<=^|\s)@\S+/gu;

const cases = [
  ['reported',        '@Бискуб Константин Николаевич/Военный билет/Военный билет 12.jpg'],
  ['reported+prose',  '@Бискуб Константин Николаевич/Военный билет/Военный билет 12.jpg распознай его'],
  ['ascii spaces',    '@My Folder/some file.md and then some prose'],
  ['no spaces',       '@src/App.tsx check this'],
  ['bare file',       '@file.md look at it'],
  ['dir mention',     '@Военный билет/ посмотри'],
  ['email control',   'write to john@corp.com about it'],
  ['handle control',  'ping @snowy_137 about the build'],
  ['RUNAWAY',         'ping @snowy about the build see src/file.md'],
  ['two mentions',    '@a/b.ts and @c/d.ts'],
];

for (const [name, text] of cases) {
  const row = { case: name };
  for (const [label, re] of [['current', CURRENT], ['B', B], ["B'", B2]]) {
    re.lastIndex = 0;
    row[label] = (text.match(re) || []).join(' | ') || '-';
  }
  console.log(`\n${row.case}\n  in : ${text}\n  now: ${row.current}\n  B  : ${row.B}\n  B' : ${row["B'"]}`);
}
