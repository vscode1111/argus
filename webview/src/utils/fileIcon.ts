/**
 * Which icon and colour a filename gets in a directory listing.
 *
 * Modelled on Seti, VS Code's default file-icon theme: a small set of glyphs and a
 * fixed eight-colour palette, where the colour carries most of the signal. Kept as
 * inline SVG in the bundle rather than an icon font on purpose - a font would be an
 * emitted asset, and the daemon serves a fixed static allowlist (`/`, `/webview.js`,
 * `/webview.css`, `/argus-icon.ico`), so it would 404 in browser mode.
 *
 * Pure and data-only so it can be tested without rendering anything.
 */

/** The Seti palette, verbatim. Using the real values is what makes it read as VS Code. */
export const ICON_COLORS = {
  blue: '#519aba',
  yellow: '#cbcb41',
  orange: '#e37933',
  red: '#cc3e44',
  green: '#8dc149',
  purple: '#a074c4',
  grey: '#6d8086',
  plain: '#d4d7d6',
} as const;

export type IconColor = keyof typeof ICON_COLORS;

/** Glyph shapes. Deliberately few: at 15px a detailed glyph turns to mush. */
export type IconKind = 'doc' | 'code' | 'braces' | 'image' | 'archive' | 'config' | 'shell' | 'db';

export interface FileIconSpec {
  kind: IconKind;
  color: IconColor;
}

type Spec = [IconKind, IconColor];

const BY_EXT: Record<string, Spec> = {
  // JavaScript / TypeScript
  js: ['code', 'yellow'], mjs: ['code', 'yellow'], cjs: ['code', 'yellow'],
  ts: ['code', 'blue'], mts: ['code', 'blue'], cts: ['code', 'blue'],
  jsx: ['code', 'blue'], tsx: ['code', 'blue'],
  // Braces, not the code glyph: a folder of scripts is mostly .js and .json, and with
  // both on the same yellow `<>` the listing goes back to being one repeated icon.
  json: ['braces', 'yellow'], jsonc: ['braces', 'yellow'], json5: ['braces', 'yellow'],
  jsonl: ['braces', 'yellow'], ndjson: ['braces', 'yellow'],
  vue: ['code', 'green'], svelte: ['code', 'orange'],

  // Other languages
  py: ['code', 'blue'], rb: ['code', 'red'], php: ['code', 'purple'],
  java: ['code', 'red'], kt: ['code', 'purple'], swift: ['code', 'orange'],
  go: ['code', 'blue'], rs: ['code', 'orange'], dart: ['code', 'blue'],
  c: ['code', 'blue'], h: ['code', 'blue'], cpp: ['code', 'blue'],
  cc: ['code', 'blue'], cxx: ['code', 'blue'], hpp: ['code', 'blue'],
  cs: ['code', 'green'], lua: ['code', 'blue'], pl: ['code', 'blue'],
  scala: ['code', 'red'], ex: ['code', 'purple'], exs: ['code', 'purple'],
  clj: ['code', 'green'], hs: ['code', 'purple'], r: ['code', 'blue'],

  // Markup and styles
  html: ['code', 'orange'], htm: ['code', 'orange'], xml: ['code', 'orange'],
  css: ['code', 'blue'], less: ['code', 'blue'],
  scss: ['code', 'purple'], sass: ['code', 'purple'], styl: ['code', 'green'],

  // Data and config
  yml: ['config', 'purple'], yaml: ['config', 'purple'],
  toml: ['config', 'grey'], ini: ['config', 'grey'], cfg: ['config', 'grey'],
  conf: ['config', 'grey'], properties: ['config', 'grey'], env: ['config', 'grey'],
  lock: ['config', 'grey'],
  sql: ['db', 'blue'], db: ['db', 'blue'], sqlite: ['db', 'blue'], sqlite3: ['db', 'blue'],
  csv: ['doc', 'green'], tsv: ['doc', 'green'],

  // Documents
  md: ['doc', 'blue'], mdx: ['doc', 'blue'], markdown: ['doc', 'blue'],
  txt: ['doc', 'grey'], log: ['doc', 'grey'], out: ['doc', 'grey'],
  pdf: ['doc', 'red'], rtf: ['doc', 'blue'], doc: ['doc', 'blue'], docx: ['doc', 'blue'],
  xls: ['doc', 'green'], xlsx: ['doc', 'green'],
  ppt: ['doc', 'orange'], pptx: ['doc', 'orange'],

  // Shell
  sh: ['shell', 'green'], bash: ['shell', 'green'], zsh: ['shell', 'green'],
  fish: ['shell', 'green'], bat: ['shell', 'green'], cmd: ['shell', 'green'],
  ps1: ['shell', 'green'],

  // Images
  png: ['image', 'purple'], jpg: ['image', 'purple'], jpeg: ['image', 'purple'],
  gif: ['image', 'purple'], bmp: ['image', 'purple'], webp: ['image', 'purple'],
  ico: ['image', 'purple'], tif: ['image', 'purple'], tiff: ['image', 'purple'],
  avif: ['image', 'purple'], svg: ['image', 'orange'],

  // Archives and binaries
  zip: ['archive', 'orange'], tar: ['archive', 'orange'], gz: ['archive', 'orange'],
  tgz: ['archive', 'orange'], '7z': ['archive', 'orange'], rar: ['archive', 'orange'],
  xz: ['archive', 'orange'], bz2: ['archive', 'orange'], jar: ['archive', 'red'],
  exe: ['config', 'grey'], dll: ['config', 'grey'], so: ['config', 'grey'],
  dylib: ['config', 'grey'], bin: ['config', 'grey'], wasm: ['config', 'purple'],

  // Fonts
  ttf: ['doc', 'purple'], otf: ['doc', 'purple'],
  woff: ['doc', 'purple'], woff2: ['doc', 'purple'],
};

/**
 * Files identified by their whole name, not an extension. Matched case-insensitively
 * so `Dockerfile` and `dockerfile` land alike; the leading dot is kept because that
 * is what distinguishes `.env` from a file called `env`.
 */
const BY_NAME: Record<string, Spec> = {
  dockerfile: ['config', 'blue'],
  makefile: ['config', 'orange'],
  license: ['doc', 'yellow'],
  '.gitignore': ['config', 'orange'],
  '.gitattributes': ['config', 'orange'],
  '.gitmodules': ['config', 'orange'],
  '.env': ['config', 'grey'],
  '.editorconfig': ['config', 'grey'],
  '.npmrc': ['config', 'red'],
  '.nvmrc': ['config', 'green'],
};

const DEFAULT_SPEC: FileIconSpec = { kind: 'doc', color: 'plain' };

/**
 * Icon for a filename. The extension is the part after the LAST dot, so
 * `archive.tar.gz` is a gz and `.corp-account` is a whole-name lookup rather than an
 * extension of `corp-account` - a leading dot does not start an extension.
 */
export function fileIconFor(name: string): FileIconSpec {
  const lower = name.toLowerCase();

  const byName = BY_NAME[lower];
  if (byName) return { kind: byName[0], color: byName[1] };

  const dot = lower.lastIndexOf('.');
  // No dot, or the only dot is the leading one: there is no extension to key on.
  if (dot <= 0) return DEFAULT_SPEC;

  const spec = BY_EXT[lower.slice(dot + 1)];
  return spec ? { kind: spec[0], color: spec[1] } : DEFAULT_SPEC;
}
