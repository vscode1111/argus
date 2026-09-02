// Does the icon mapping key off the right part of a filename?
// Run: npx tsx !notes/tasks/dir-preview/scripts/probe-icons.ts
import { fileIconFor } from '../../../../webview/src/utils/fileIcon';

const cases: [string, string, string][] = [
  // [filename, expected kind, expected colour]
  ['audit-mr.js', 'code', 'yellow'],
  ['App.tsx', 'code', 'blue'],
  ['package.json', 'braces', 'yellow'],
  ['notes.md', 'doc', 'blue'],
  ['styles.module.css', 'code', 'blue'],
  ['run.sh', 'shell', 'green'],
  ['start.bat', 'shell', 'green'],
  ['screenshot.png', 'image', 'purple'],
  ['icon.svg', 'image', 'orange'],
  ['argus.json', 'braces', 'yellow'],
  ['config.yml', 'config', 'purple'],
  ['schema.sql', 'db', 'blue'],
  ['bundle.tar.gz', 'archive', 'orange'],   // last dot wins, not the first
  ['Dockerfile', 'config', 'blue'],         // whole-name match
  ['dockerfile', 'config', 'blue'],         // case-insensitive
  ['LICENSE', 'doc', 'yellow'],
  ['.gitignore', 'config', 'orange'],       // leading dot is a name, not an extension
  ['.env', 'config', 'grey'],
  ['.corp-account', 'doc', 'plain'],        // a dotfile with no mapping: default, never
                                            // an extension lookup for "corp-account"
  ['README', 'doc', 'plain'],               // no dot at all
  ['weird.zzz', 'doc', 'plain'],            // unknown extension
  ['acts-debug.json', 'braces', 'yellow'],
];

let fails = 0;
for (const [name, kind, color] of cases) {
  const got = fileIconFor(name);
  const ok = got.kind === kind && got.color === color;
  if (!ok) fails++;
  console.log(
    (ok ? 'ok   ' : 'FAIL ') + name.padEnd(22) +
    got.kind.padEnd(8) + got.color +
    (ok ? '' : `   wanted ${kind}/${color}`)
  );
}
console.log(fails ? `\n${fails} FAILING` : '\nall cases pass');
process.exit(fails ? 1 : 0);
