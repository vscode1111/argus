import * as fs from 'fs';
import * as path from 'path';

const IMAGE_EXTS: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
};

// Playable media. The mapping is by extension rather than by sniffing the container,
// because it decides which element the client renders, and `<video>` vs `<audio>` is a
// layout question the file's magic bytes do not answer (an .m4a and an .m4v share one).
// Formats the browser may not decode (.mkv, .avi) are listed on purpose: the player
// reports that itself, and refusing here would show a worse error than the real one.
export const VIDEO_EXTS: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.ogv': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
};

export const AUDIO_EXTS: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.weba': 'audio/webm',
};

/** How much of a file is sniffed to decide whether it is text at all. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Whether a file is binary, by the same rule git uses: a NUL byte in the first few KB.
 *
 * This exists because everything that was not a directory or an image used to be read
 * with `readFileSync(path, 'utf-8')`, so a .mp4 (and equally a .zip, .exe or .pdf) was
 * decoded as text and shipped whole: the 21.5MB video that prompted this became a 51MB
 * WebSocket frame holding 87,580 "lines" of replacement characters. Cheap to detect and
 * the cost of being wrong is small in both directions - a text file misread as binary
 * shows its size instead of its contents, which is recoverable, while the reverse hangs
 * the panel.
 */
function looksBinary(fd: number): boolean {
  const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
  const read = fs.readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
  return buf.subarray(0, read).includes(0);
}

/** One row of a directory preview. `size` is bytes, files only. */
export interface PreviewEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

/** A file the client plays rather than renders. Bytes never travel with this. */
export interface MediaInfo {
  kind: 'video' | 'audio';
  mediaType: string;
  size: number;
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
  /** Present for audio/video: the client asks for a media grant and streams it. */
  media?: MediaInfo;
  /** Present for a non-media binary: its size, since there is nothing to render. */
  binary?: { size: number };
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
    // Media is described, never sent: the client exchanges this for a grant and streams
    // it over HTTP. The webview also recognises these extensions itself and normally
    // skips straight to that, so this branch is the guard for every other way a path can
    // arrive here - a directory listing, an older client, a link inside a preview.
    const videoType = VIDEO_EXTS[ext];
    const audioType = AUDIO_EXTS[ext];
    if (videoType || audioType) {
      return {
        path: filePath,
        content: '',
        media: {
          kind: videoType ? 'video' : 'audio',
          mediaType: videoType || audioType,
          size: fs.statSync(filePath).size,
        },
      };
    }
    // Sniff before reading. Decoding a binary as UTF-8 is what produced the 51MB frame,
    // and it is not specific to video: a .zip or .exe does exactly the same thing.
    const fd = fs.openSync(filePath, 'r');
    let binary: boolean;
    let size: number;
    try {
      binary = looksBinary(fd);
      size = fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
    if (binary) return { path: filePath, content: '', binary: { size } };
    // By path, not by the descriptor above: readFileSync(fd) reads from the current file
    // position, which is a detail of how the sniff happened to be done and not something
    // this line should depend on.
    return { path: filePath, content: fs.readFileSync(filePath, 'utf-8') };
  } catch (err) {
    return { path: filePath, content: `Error reading file: ${(err as Error).message}` };
  }
}
