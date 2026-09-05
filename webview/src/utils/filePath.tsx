import React from 'react';
import { usePreview } from '../contexts/PreviewContext';
import { URL_RE, trimUrl, openExternal } from './url';

// Matches file paths with optional :line or :line-endLine suffix
// Windows absolute: D:\path\to\file.ext:123, D:\path\to\folder, D:\path\to\folder\
// Unix absolute: /path/to/file.ext:123, /path/to/folder/
// Relative: src/file.ext, webview/src/App.tsx, src/backend/
// Directory segments may start with "!" (the !notes convention); the final
// filename class stays without it so prose like "done!file.md" is not swallowed.
// The suffix is `.ext` plus any number of `-part` groups, because a dotfile name is
// routinely hyphenated (`.corp-account`, `.menu-cms`): with a plain `\.\w+` the match
// stopped at the hyphen and the link pointed at `...\credentials\.corp`, a file that
// does not exist. `\w` excludes Cyrillic, so a Russian suffix ("`.md`-файл") still
// ends the match. The final segment may also start with the dot (`/etc/.gitignore`),
// hence `*` rather than `+` before it on the unix and relative branches.
//
// A directory is a first-class target (the previewer lists one), so the "must end in
// .ext" requirement is dropped - but ONLY on the Windows branch, where the drive letter
// says "this is a filesystem path" and nothing else does. The whole run matches, ending
// in a final segment plus an optional separator. Two guards on that final segment:
//   - it may not end in a dot, so a sentence's full stop stays prose, and the elision
//     `C:\...` (shorthand for a path, not a path) does not linkify;
//   - it may not be empty, so a bare `C:\` is not a link either.
// Dropping the extension requirement on the slash branches was tried and reverted: a
// URL path in prose is shaped exactly like a directory, so `GET /api/probes/headers`
// and `/api/v4/projects/6829/merge_requests/99/discussions/` both became links to
// folders that do not exist. A leading slash is not evidence of a filesystem, and for a
// bare relative path there is no evidence at all ("and/or", "24/7").
// Without the Windows widening the link stopped at the last dotted segment: the folder
// `C:\Users\Admin\.claude\skills\git-remarks\scripts\` came out as a link to
// `C:\Users\Admin\.claude`, a real but entirely different directory.
//
// "@" is a filename character (`out\@snowy_137.json`, a per-handle dump) and a directory
// one (`node_modules\@types\node\index.d.ts`), and it is allowed **anywhere** on the
// Windows branch, where the drive letter is the evidence and an email cannot appear.
// On the slash branches it is allowed in a directory segment but only at the *start* of
// the final one (`@?`), because that is where a scoped name puts it while an address puts
// it in the middle: without that guard `docs/john@corp.com` becomes a file link. Failing
// to accept it at all was not "no link" but a link to something else - the reported
// `D:\_Projects\_tools\telegram\out\@snowy_137.json` linked the prefix
// `D:\_Projects\_tools\telegram\out\`, an existing folder, so the click opened a
// directory listing; `/home/u/node_modules/@types/node/index.d.ts` fell through to the
// relative branch and linked `home/u/...`, silently dropping the leading slash.
// `\w` is ASCII-only in JS, so a Cyrillic segment used to END the match and - because a
// directory is a valid target - it fell back to the longest ASCII prefix:
// `d:\_BiskubFamily\Docs\Бискуб Константин Николаевич\_index.md` linked
// `d:\_BiskubFamily\Docs\`, a real folder, so the click opened a listing and nothing looked
// broken. Same failure shape as the `@snowy_137.json` bug. Hence `[\p{L}\p{N}_]` + the `u`
// flag. The post-extension `(?:-\w+)*` group stays deliberately ASCII: it exists for
// hyphenated dotfiles (`.corp-account`), and widening it would swallow the Russian suffix
// in "`.md`-файл", which the ASCII class is what keeps out of the link.
//
// A space is allowed in a NON-FINAL segment only, and on the Windows branch only. Real
// paths here are full of them (`Бискуб Константин Николаевич\`, `Военный билет\`) and
// without this the match merely breaks in a new place. The constraint is what keeps prose
// out: a segment may not START with a space, so `see d:\Docs\ and also x\y.md` stops dead
// at `d:\Docs\` instead of running through the sentence to the next backslash.
//
// The FINAL segment needs spaces too (`…\Военный билет\Военный билет 12.jpg` - the reported
// path), and that is where prose gets swallowed, so it is anchored on an extension and the
// space-crossing is LAZY: `file.md and see other.txt here` stops at `file.md` because zero
// space-words already satisfies `.ext`, whereas a greedy scan would run to `other.txt`. The
// same runaway killed every candidate rule for the @-mention. The `(?:-…)*` tail must stay
// on that branch or a hyphenated dotfile regresses - `.corp-account` would match `.corp`,
// the exact bug that branch was written for. The dotless alternative that follows keeps
// bare directories working (`…\scripts\`), which the extension anchor cannot express.
// The slash branches get Unicode but NOT spaces - a leading slash is not evidence of a
// filesystem (see the reverted slash widening), and a bare relative path is no evidence.
//
// Composed from named parts rather than written as one literal: with Unicode classes and
// the spaced/lazy branches it ran to ~500 inline characters, which is not reviewable, and
// WIN_PATH_RE in markdown.tsx has to stay in step with it (they run in sequence over the
// same text, so a class one accepts and the other rejects half-renders a path). The parts
// are exported for that file to build its own, looser, pattern from.

/** One character of a path segment. Unicode: a Cyrillic folder name is a folder name. */
export const PATH_CH = '[\\p{L}\\p{N}_.\\-!@]';

/** The same, minus the dot - see PATH_SEG for why a spaced segment must be dot-free. */
const PATH_CH_ND = '[\\p{L}\\p{N}_\\-!@]';

/**
 * A non-final segment. Either several space-joined words, or one word that may contain
 * dots - never both, and it may never START with a space.
 *
 * The no-leading-space guard stops `see d:\Docs\ and also x\y.md` at `d:\Docs\` instead of
 * running to the next backslash. The dot-free guard is what a 78k-block transcript audit
 * forced: the segment loop is greedy, so it happily ate prose whenever a separator turned
 * up later in the sentence - `…\tools\vault.js show companies/GMTrade/credentials/.linear`
 * and `…\index.d.ts here.\` were both linked whole. Every one of those starts by crossing a
 * space that follows a dotted filename, while real spaced directories are dot-free
 * (`Program Files`, `Бискуб Константин Николаевич`, `Военный билет`, `User Data`).
 *
 * Residual, and irreducible without touching the filesystem: a dot-free prose run that
 * happens to be followed by a separator still matches (`_tools/telegram and check dist/`).
 * That is the same ambiguity that killed every @-mention rule, and the reason the picker
 * resolves against the host instead of guessing.
 */
export const PATH_SEG = `(?:${PATH_CH_ND}+(?: ${PATH_CH_ND}+)+|${PATH_CH}+)`;

/**
 * The final segment, as two alternatives in order:
 *  1. spaces allowed, anchored on an extension, and crossing them LAZILY so
 *     `file.md and see other.txt here` stops at `file.md`; a greedy scan would run to
 *     `other.txt`, the same runaway that killed every candidate @-mention rule. Its
 *     `(?:-…)*` tail is required or `.corp-account` regresses to `.corp`.
 *  2. no spaces, no extension needed - bare directories (`…\scripts\`), which the
 *     extension anchor cannot express. May not end in a dot, so a sentence's full stop
 *     stays prose and the elision `C:\...` does not linkify.
 *
 * The extension itself stays ASCII while the rest of the segment is Unicode. Widening it
 * too made Russian initials read as one: `…\Согласие на дарение Бискуб Н.М` matched with
 * `.М` as the extension, so a spaced prose tail linked as a file. A genuinely
 * Cyrillic-suffixed extension is vanishingly rare; initials next to a path are not.
 */
export const PATH_FINAL = `(?:${PATH_CH}+ )*?${PATH_CH}*\\.[A-Za-z\\d]+(?:-[A-Za-z\\d]+)*|${PATH_CH}*[\\p{L}\\p{N}\\-!]`;

/**
 * Drive-letter tail. Either one-or-more separator-terminated segments with an OPTIONAL
 * final one, or a final one alone. Written this way so a spaced directory keeps its
 * trailing separator (`d:\Docs\Военный билет\`) while a bare `C:\` and the elision
 * `C:\...` still match nothing - making the final segment simply optional would linkify
 * both of those, and requiring it truncated the directory to `d:\Docs\Военный`.
 */
export const WIN_TAIL = `(?:(?:${PATH_SEG}[\\\\/])+(?:${PATH_FINAL})?|${PATH_FINAL})`;

const FILE_PATH_RE = new RegExp(
  '(' +
    `(?<![a-zA-Z])[A-Za-z]:[\\\\/]${WIN_TAIL}` +
    `|\\/(?:${PATH_CH}+\\/)+@?[\\p{L}\\p{N}_.\\-]*\\.[\\p{L}\\p{N}_]+(?:-\\w+)*` +
    `|(?:${PATH_CH}+[\\\\/])+@?[\\p{L}\\p{N}_.\\-]*\\.[\\p{L}\\p{N}_]+(?:-\\w+)*` +
  ')' +
  '(?::(\\d+)(?:-(\\d+))?)?',
  'gu'
);

// The preview itself is owned by PreviewProvider, not by this link: markdown is
// re-rendered constantly while a turn streams and the message it belongs to is
// remounted when the turn commits, either of which would close a modal held here.
function FilePathLink({ path: origPath, line, display }: { path: string; line?: number; display: string }) {
  const previewer = usePreview();

  return (
    <a
      className="file-path-link"
      href="#"
      title={`Open ${origPath}`}
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        previewer.open({ kind: 'path', path: origPath, line });
      }}
    >
      {display}
    </a>
  );
}

const MAX_LINKIFY_LENGTH = 5000;

// A URL's path component is indistinguishable from a real path, so FILE_PATH_RE used to
// claim the tail of a link: `https://192.168.0.12/ui/scripts/main.js` came out with
// `/192.168.0.12/ui/scripts/main.js` underlined and opening a preview for a file that does
// not exist, and `http://localhost:3001/webview.js` broke mid-host into `3001/webview.js`.
// The URL is still a link - it just has to open as a URL, so it is matched first and
// rendered by UrlLink, and the path scan only ever sees the spans between URLs. In prose
// remark-gfm has already produced an <a> (which withLinkedPaths skips); this covers the
// places it does not reach - code spans, fenced blocks and the body of a user message.
function UrlLink({ url }: { url: string }) {
  return (
    <a
      className="external-url-link"
      href={url}
      title={`Open ${url}`}
      onClick={e => {
        e.preventDefault();
        e.stopPropagation();
        openExternal(url);
      }}
    >
      {url}
    </a>
  );
}

function pushLinkedPaths(text: string, offset: number, parts: React.ReactNode[]): void {
  let lastIndex = 0;
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const fullMatch = match[0];
    const filePath = match[1];
    const line = match[2] ? parseInt(match[2], 10) : undefined;
    // match[3] (the end of a `:12-80` range) is part of the link text only - the
    // viewer scrolls to a single line and has never accepted an end line.
    parts.push(
      <FilePathLink key={offset + match.index} path={filePath} line={line} display={fullMatch} />
    );

    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
}

/**
 * Takes a plain text string and returns React nodes with detected file paths
 * rendered as clickable links that open a FileViewerModal on click.
 */
export function linkifyPaths(text: string): React.ReactNode {
  if (text.length > MAX_LINKIFY_LENGTH) return text;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  URL_RE.lastIndex = 0;
  let url: RegExpExecArray | null;

  while ((url = URL_RE.exec(text)) !== null) {
    pushLinkedPaths(text.slice(lastIndex, url.index), lastIndex, parts);
    const href = trimUrl(url[0]);
    parts.push(<UrlLink key={`u${url.index}`} url={href} />);
    // Punctuation the regex swallowed is ordinary text, not part of the link.
    if (href.length < url[0].length) parts.push(url[0].slice(href.length));
    lastIndex = url.index + url[0].length;
  }
  pushLinkedPaths(text.slice(lastIndex), lastIndex, parts);

  // Nothing matched: hand back the original string rather than a fragment.
  if (parts.length === 1 && typeof parts[0] === 'string') return parts[0];
  if (parts.length === 0) return text;

  return <>{parts}</>;
}

// Matches "@path" mentions at a word boundary (start or after whitespace), so emails
// like a@b.com aren't highlighted.
//
// The quoted alternative is not cosmetic. The CLI expands `@notes.md` but NOT
// `@My Folder/some file.md` - its own parser stops at the first space, so a path with
// spaces is silently never attached to the turn, and the model goes hunting for a file it
// was already handed. `@"path with spaces"` is the form it does accept (verified against a
// real CLI, relative and absolute: !notes/tasks/path-with-spaces-mention/notes.md).
//
// Being delimited, that form is also unambiguous to match here, which is why deciding
// where a mention ends needs no filesystem lookup. Three space-crossing rules were tried
// and killed before this; `ping @snowy about the build see src/file.md` defeats all of
// them, so do not reach for one again (scripts/probe-mention-re.js in that task).
const MENTION_RE = /(?<=^|\s)@(?:"[^"\n]*"|\S+)/g;

export interface MentionMatch {
  start: number;
  end: number;
  text: string;
}

/**
 * Mention ranges in `text`. Shared by the two surfaces that colour them - the InputArea
 * highlight overlay and the sent user bubble - which previously each kept their own copy
 * of the pattern, which is exactly why the space bug had to be fixed in two places.
 */
export function findMentions(text: string): MentionMatch[] {
  const out: MentionMatch[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

/**
 * Like linkifyPaths, but additionally colors "@path" mentions blue (matching the input box).
 * Non-mention spans are still run through linkifyPaths so absolute paths stay clickable.
 */
export function linkifyWithMentions(text: string): React.ReactNode {
  if (text.length > MAX_LINKIFY_LENGTH) return text;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const m of findMentions(text)) {
    if (m.start > lastIndex) {
      parts.push(<React.Fragment key={`t${lastIndex}`}>{linkifyPaths(text.slice(lastIndex, m.start))}</React.Fragment>);
    }
    parts.push(<span key={`m${m.start}`} className="mention-path">{m.text}</span>);
    lastIndex = m.end;
  }

  if (parts.length === 0) return linkifyPaths(text);
  if (lastIndex < text.length) {
    parts.push(<React.Fragment key={`t${lastIndex}`}>{linkifyPaths(text.slice(lastIndex))}</React.Fragment>);
  }
  return <>{parts}</>;
}

/**
 * Recursively processes React children, linkifying file paths in string nodes.
 */
function isLinkElement(el: React.ReactElement): boolean {
  return el.type === 'a' || (el.props as Record<string, unknown>)?.href != null;
}

export function withLinkedPaths(children: React.ReactNode): React.ReactNode {
  if (typeof children === 'string') {
    return linkifyPaths(children);
  }
  if (Array.isArray(children)) {
    return children.map((child, i) =>
      typeof child === 'string'
        ? <React.Fragment key={i}>{linkifyPaths(child)}</React.Fragment>
        : React.isValidElement(child)
          ? (isLinkElement(child)
            ? child
            : React.cloneElement(child, { key: i } as Record<string, unknown>, withLinkedPaths((child.props as { children?: React.ReactNode }).children)))
          : child
    );
  }
  if (React.isValidElement(children)) {
    if (isLinkElement(children)) return children;
    return React.cloneElement(children, {} as Record<string, unknown>, withLinkedPaths((children.props as { children?: React.ReactNode }).children));
  }
  return children;
}
