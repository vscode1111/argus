import * as fs from 'fs';
import * as path from 'path';

const IMAGE_EXTS: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
};

/** One row of a directory preview. `size` is bytes, files only. */
export interface PreviewEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export interface FilePreviewResult {
  path: string;
  content: string;
  /** Present iff `path` is a directory - the client renders a listing instead of code. */
  entries?: PreviewEntry[];
  /** Parent directory, absent at a filesystem root (there is nowhere further up). */
  parent?: string;
  /** Entries dropped past the cap, so the listing can say what it is not showing. */
  truncated?: number;
}

// A directory can hold tens of thousands of entries (node_modules, a download
// folder), and the whole listing crosses the wire in one frame. Cap it, count what
// was dropped, and let the user narrow down by walking in.
const MAX_DIR_ENTRIES = 1000;

// Explorer order: folders first, then files, each case-insensitively alphabetical.
function compareEntries(a: PreviewEntry, b: PreviewEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

// List a directory for the previewer. Sizes are stat'd only for the entries that
// survive the cap, so a huge folder costs one readdir rather than 50k stats.
function readDirPreview(dir: string): FilePreviewResult {
  const all: PreviewEntry[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try { isDir = fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { isDir = false; }
    }
    all.push({ name: d.name, path: path.join(dir, d.name), isDir });
  }
  all.sort(compareEntries);

  const entries = all.slice(0, MAX_DIR_ENTRIES);
  for (const e of entries) {
    if (e.isDir) continue;
    try { e.size = fs.statSync(e.path).size; } catch { /* vanished or unreadable */ }
  }

  const parent = path.dirname(dir);
  return {
    path: dir,
    content: '',
    entries,
    // At 'C:\' or '/' dirname returns the path itself: there is no up from here.
    parent: parent === dir ? undefined : parent,
    truncated: all.length > entries.length ? all.length - entries.length : undefined,
  };
}

export function readFilePreview(
  requestedPath: string,
  workspaceDir: string,
): FilePreviewResult {
  const filePath = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(workspaceDir, requestedPath);
  const resolved = path.resolve(filePath);

  // Containment check for relative paths. Compare via path.relative so the guard
  // is robust to separator style (forward vs back slash) and drive-letter casing
  // in workspaceDir - a raw string startsWith on `workspaceDir + sep` wrongly
  // rejected valid paths when workspaceDir used '/' on win32.
  if (!path.isAbsolute(requestedPath)) {
    const rel = path.relative(path.resolve(workspaceDir), resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { path: requestedPath, content: 'Error: path outside workspace' };
    }
  }

  try {
    // A directory is a perfectly ordinary thing to click: the linkifier hands one
    // over whenever the final segment has no extension, and prose names folders
    // outright. Reading it raised EISDIR, so the preview opened on an error where
    // a listing is what the user asked to see.
    if (fs.statSync(filePath).isDirectory()) {
      return readDirPreview(resolved);
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = IMAGE_EXTS[ext];
    if (mime) {
      const base64 = fs.readFileSync(filePath).toString('base64');
      return { path: filePath, content: `data:${mime};base64,${base64}` };
    }
    return { path: filePath, content: fs.readFileSync(filePath, 'utf-8') };
  } catch (err) {
    return { path: filePath, content: `Error reading file: ${(err as Error).message}` };
  }
}
