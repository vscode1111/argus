// Reports literal backslash-backtick sequences in markdown, which render as a visible "\`"
// instead of a code span. They creep in when a code span is nested inside another one and
// the inner delimiters get escaped by hand; use double-backtick delimiters instead.
//
// Kept as a file rather than a `node -e` one-liner on purpose: the pattern contains both a
// backslash and a backtick, and passing it through Git Bash silently degraded it to a plain
// backtick match, which reported ~700 false hits in a file that had none.
//
// Usage: node check-escaped-backticks.js <file.md> [...]

const fs = require('fs');

let bad = 0;
for (const file of process.argv.slice(2)) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => {
    if (line.includes('\\' + '`')) hits.push(i + 1);
  });
  if (hits.length) {
    bad += hits.length;
    console.log(`${file}: ${hits.length} line(s) with a literal backslash-backtick -> ${hits.join(', ')}`);
  } else {
    console.log(`${file}: clean`);
  }
}
process.exit(bad ? 1 : 0);
