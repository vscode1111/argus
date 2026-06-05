/** Last non-empty segment of a Windows or Unix path (e.g. the workspace folder name). */
export function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
}
