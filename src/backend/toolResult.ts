/**
 * Flattening of CLI tool results, with the base64 images taken out.
 *
 * A Read of a .png/.jpg comes back as an image block, not as text, and those blocks
 * are by far the largest thing Argus ever puts on the wire: one real session held 48
 * of them, 23.4MB of base64, in a 24.2MB replay payload. None of it was ever rendered
 * - the preview re-read the file from disk instead, which also meant a file moved or
 * deleted after the tool ran previewed as `Error reading file: ENOENT` even though the
 * image the model saw was sitting right there in the transcript.
 *
 * So the bytes are replaced by a short marker on both paths that feed the webview
 * (live tool_end in cliHandler, replay in sessions.loadSession) and fetched one at a
 * time, per click, by readToolImage(). Over a remote link that is the difference
 * between paying for every image the agent looks at and paying for the ones you open.
 */

export interface ToolImage {
  mediaType: string;
  /** Raw base64, no `data:` prefix. */
  data: string;
}

/** The image carried by a content block, or null when it is not a base64 image. */
export function imageFromBlock(block: unknown): ToolImage | null {
  const b = block as { type?: string; source?: { type?: string; media_type?: string; data?: string } } | null;
  if (!b || b.type !== 'image') return null;
  const src = b.source;
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return null;
  return { mediaType: src.media_type || 'image', data: src.data };
}

/** What stands in for the bytes in the tool row, e.g. `[image image/jpeg 174 KB]`. */
export function imageMarker(img: ToolImage): string {
  const bytes = Math.floor((img.data.length * 3) / 4);
  const size = bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
  return `[image ${img.mediaType} ${size}]`;
}

function flattenBlock(block: unknown): string {
  if (typeof block === 'string') return block;
  const img = imageFromBlock(block);
  if (img) return imageMarker(img);
  const b = block as { type?: string; text?: string } | null;
  if (b && b.type === 'text') return b.text ?? '';
  return JSON.stringify(block);
}

/**
 * Flatten a tool result (a string, a block array, or a single block) into the string
 * the webview renders. Image blocks become markers; everything else keeps the shape
 * it always had.
 */
export function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) return content.map(flattenBlock).join('\n');
  return flattenBlock(content);
}
