const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const rootIndex = fs.readFileSync(path.join(root, 'INDEX.md'), 'utf8');
let failures = 0;
for (const relative of ['INDEX.md', 'common/INDEX.md', 'tasks/INDEX.md']) {
  const file = path.join(root, relative);
  const seen = new Set();
  for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trimStart().startsWith('|')) continue;
    const links = [...line.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]);
    if (links.length && seen.has(links[0])) {
      console.log(`DUPLICATE ${relative}:${index + 1} ${links[0]}`);
      failures++;
    }
    if (links.length) seen.add(links[0]);
    for (const link of links) {
      if (/^(https?:|mailto:)/.test(link)) continue;
      const target = path.resolve(path.dirname(file), link.split('#')[0]);
      if (!fs.existsSync(target)) {
        console.log(`MISSING ${relative}:${index + 1} ${link}`);
        failures++;
      }
    }
  }
}

for (const [heading, relative, prefix] of [
  ['Common docs', 'common/INDEX.md', 'common/'],
  ['Task notes', 'tasks/INDEX.md', 'tasks/'],
]) {
  const section = rootIndex.split(`### ${heading}\n`)[1]?.split(/\n(?:### |## )/)[0] || '';
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  for (const row of source.split(/\r?\n/).filter(line => /^\| \[[^]]+\]\([^)]+\) \|/.test(line))) {
    const mirrored = row.replace(/\]\((?!https?:)([^)]+)\)/g, (_, link) => `](${prefix}${link})`);
    if (!section.includes(mirrored)) {
      console.log(`UNMIRRORED ${relative} ${row.match(/\]\(([^)]+)\)/)?.[1]}`);
      failures++;
    }
  }
}

const tasks = path.join(root, 'tasks');
const taskIndex = fs.readFileSync(path.join(tasks, 'INDEX.md'), 'utf8');
for (const slug of fs.readdirSync(tasks)) {
  const folder = path.join(tasks, slug);
  if (!fs.statSync(folder).isDirectory()) continue;
  const markdown = fs.readdirSync(folder).filter(name => name.endsWith('.md'));
  if (!markdown.length) {
    console.log(`ORPHAN tasks/${slug}`);
    failures++;
  }
  if (!taskIndex.includes(`[${slug}/](${slug}/)`)) {
    console.log(`UNINDEXED tasks/${slug}`);
    failures++;
  }
}
console.log(`${failures} index issues`);
process.exitCode = failures ? 1 : 0;
