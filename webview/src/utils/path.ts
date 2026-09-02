/** Last non-empty segment of a Windows or Unix path (e.g. the workspace folder name). */
export function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
}

/** A trailing separator is cosmetic; the host resolves `C:\dir\` to `C:\dir`. */
const stripTrailingSep = (p: string) => p.replace(/[\\/]+$/, '') || p;

/**
 * Does the host's `filePreview` answer correspond to the path we asked for?
 *
 * The backend replies with a **resolved absolute** path, so a relative or
 * slash-flipped request can only match by suffix. It also drops a trailing
 * separator, which matters now that a directory link carries one: asking for
 * `...\scripts\` and being answered `...\scripts` failed every comparison, and the
 * modal sat on its spinner until the 20s timeout rather than showing the listing.
 */
export function matchesRequestedPath(got: string, wanted: string): boolean {
  const g = stripTrailingSep(got);
  const w = stripTrailingSep(wanted);
  return g === w || g.endsWith(w) || g.endsWith(w.replace(/\//g, '\\'));
}
