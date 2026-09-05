import * as fs from 'fs';
import * as path from 'path';

// Backing store for the "@" picker. Neither existing message could serve it: listDir
// (sessions.ts) filters to directories, so it cannot see a file, and readFilePreview reads
// the whole file just to prove it exists.
//
// Both files AND directories are returned. An "@folder" mention is not decoration - the
// CLI inlines the CONTENTS of every file underneath it (measured: with every file-reading
// tool disallowed the model still quoted tokens from inside two files in a mentioned
// folder), so picking one is a real, and potentially very expensive, action. `childCount`
// is returned for exactly that reason: the row can say how much is about to be pulled in.

export interface FileHit {
  /** Path relative to the workspace, forward-slashed. Directories keep a trailing slash. */
  rel: string;
  /** Last segment, what the row shows. */
  name: string;
  /** Parent folder, forward-slashed with a trailing slash; '' at the workspace root. */
  parent: string;
  isDir: boolean;
  /** Immediate entries, directories only. Lets the UI warn before a folder is inlined. */
  childCount?: number;
}

export interface FileSearchResult {
  query: string;
  hits: FileHit[];
  /** True when the cap cut a search short, so the UI can say "keep typing". */
  truncated: boolean;
  /** 'browse' lists one directory; 'search' walks the tree. See searchFiles. */
  mode: 'browse' | 'search';
  /** The directory being browsed, relative with a trailing slash; '' at the root. */
  base: string;
  /** Parent of `base`, for the picker's up row. null at the root and when searching. */
  parent: string | null;
}

// Directories that are never what someone means by "@", and would otherwise dominate a
// recursive search. Skipped wholesale rather than filtered afterwards, so they cost nothing.
// Only applied when searching - browsing a level shows what is actually there, the way an
// explorer does.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__',
  'target', 'vendor', '.gradle', '.idea', 'test-results', 'playwright-report',
]);

const MAX_HITS = 400;
const MAX_DEPTH = 8;

/**
 * Two modes, because the picker is a file explorer first and a search box second.
 *
 * **browse** - an empty query, or one that names an existing directory (it ends in "/",
 * which is exactly what picking a folder inserts). Lists that ONE directory: immediate
 * children only, directories before files, alphabetical. This is the default, and it is
 * what an explorer window shows. A recursive dump of the whole tree was the first shape of
 * this and buried the top level under hundreds of nested folders.
 *
 * **search** - any other query. Walks the tree with a case-insensitive substring test on
 * the path relative to the workspace, directories first, capped. This is the "find it
 * wherever it lives" case, and the only one that should ever cross a directory boundary.
 *
 * `toLocaleLowerCase` throughout, because the names this was built for are Cyrillic.
 */
export function searchFiles(workspaceDir: string, query: string): FileSearchResult {
  const root = path.resolve(workspaceDir);
  const raw = query.trim();
  const browseRel = browseTarget(root, raw);

  if (browseRel !== null) {
    const hits = listLevel(root, browseRel);
    return {
      query,
      hits,
      truncated: false,
      mode: 'browse',
      base: browseRel,
      parent: browseRel === '' ? null : parentOf(browseRel),
    };
  }

  const { hits, truncated } = walkSearch(root, raw.toLocaleLowerCase());
  return { query, hits, truncated, mode: 'search', base: '', parent: searchParent(root, raw) };
}

/**
 * The folder a search query is being typed INSIDE, so the picker can still offer its up
 * row. Reported: hand-editing a path down to `…/experiments/icons1` - no trailing slash,
 * therefore search mode - lost the back row entirely, and there was no way out but to
 * delete characters.
 *
 * It is the directory prefix (everything up to the last "/"), which is where "back" means
 * "drop the half-typed name and show me that folder". Null when the query has no "/" at
 * all: a global search like `@паспорт` has no directory context, so there is nothing
 * truthful to navigate up to.
 */
function searchParent(root: string, query: string): string | null {
  const cut = query.lastIndexOf('/');
  if (cut === -1) return null;
  const rel = query.slice(0, cut + 1);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(abs).isDirectory()) return null;
  } catch {
    return null; // a prefix that does not exist (mid-typo) has nothing to go back to
  }
  return rel;
}

/**
 * The directory a query means to browse, or null when it is a search term. '' is the
 * workspace root. Requires the trailing slash: it is the explicit "go into this" signal,
 * and it is what the picker inserts when a folder is chosen, so a half-typed folder name
 * keeps searching instead of jumping into a directory mid-keystroke.
 */
function browseTarget(root: string, query: string): string | null {
  if (query === '') return '';
  if (!query.endsWith('/')) return null;
  const rel = query.slice(0, -1);
  const abs = path.resolve(root, rel);
  // Containment guard: a "../" in the query must not walk out of the workspace.
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    if (!fs.statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  return rel === '' ? '' : `${rel.replace(/\\/g, '/')}/`;
}

function parentOf(rel: string): string {
  const trimmed = rel.replace(/\/$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut === -1 ? '' : `${trimmed.slice(0, cut)}/`;
}

/** One directory's immediate children, directories first then files, alphabetical. */
function listLevel(root: string, baseRel: string): FileHit[] {
  const abs = path.resolve(root, baseRel);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return []; // unreadable (permissions, removed media) - an empty level, still navigable up
  }

  const hits: FileHit[] = [];
  for (const e of entries) {
    const isDir = resolveIsDir(abs, e);
    const rel = baseRel ? `${baseRel}${e.name}` : e.name;
    hits.push({
      rel: isDir ? `${rel}/` : rel,
      name: e.name,
      parent: baseRel,
      isDir,
      ...(isDir ? { childCount: countChildren(path.join(abs, e.name)) } : {}),
    });
  }
  return sortHits(hits);
}

function walkSearch(root: string, needle: string): { hits: FileHit[]; truncated: boolean } {
  const hits: FileHit[] = [];
  let truncated = false;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (hits.length >= MAX_HITS) { truncated = true; return; }
    if (depth > MAX_DEPTH) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (hits.length >= MAX_HITS) { truncated = true; return; }
      const isDir = resolveIsDir(dir, e);
      if (isDir && SKIP_DIRS.has(e.name)) continue;

      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (childRel.toLocaleLowerCase().includes(needle)) {
        hits.push({
          rel: isDir ? `${childRel}/` : childRel,
          name: e.name,
          parent: rel ? `${rel}/` : '',
          isDir,
          ...(isDir ? { childCount: countChildren(path.join(dir, e.name)) } : {}),
        });
      }
      if (isDir) walk(path.join(dir, e.name), childRel, depth + 1);
    }
  };

  walk(root, '', 0);
  return { hits: sortHits(hits), truncated };
}

function resolveIsDir(dir: string, e: fs.Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; }
}

// Collation is pinned rather than left to the host locale. The daemon here resolves to
// ru-RU, where Cyrillic sorts BEFORE Latin, so a folder listing ended
// `Полезные ссылки.md, CLAUDE.md` while Windows Explorer showed the two the other way
// round - a visible mismatch against the thing this list is meant to imitate. `numeric`
// additionally keeps `2` before `10`, which an explorer also does.
const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Directories before files, then alphabetical by path - an explorer's order. */
function sortHits(hits: FileHit[]): FileHit[] {
  return hits.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return COLLATOR.compare(a.rel, b.rel);
  });
}

function countChildren(dir: string): number {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * The text the picker inserts. Double quotes when the path contains a space, because the
 * CLI's own "@" parser stops at the first one and drops the mention silently - verified
 * against a real CLI, in the exact mode session.ts spawns
 * (!notes/tasks/path-with-spaces-mention/notes.md). Quoting unconditionally was rejected:
 * it puts quotes around the common case for no reason.
 */
export function mentionFor(rel: string): string {
  return rel.includes(' ') ? `@"${rel}"` : `@${rel}`;
}
