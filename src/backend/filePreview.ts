import * as fs from 'fs';
import * as path from 'path';

const IMAGE_EXTS: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.tiff': 'image/tiff', '.tif': 'image/tiff',
};

export function readFilePreview(
  requestedPath: string,
  workspaceDir: string,
): { path: string; content: string } {
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
