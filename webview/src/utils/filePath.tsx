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
const FILE_PATH_RE = /((?<![a-zA-Z])[A-Za-z]:[\\\/](?:[\w.\-!]+[\\\/])*[\w.\-!]*[\w\-!][\\\/]?|\/(?:[\w.\-!]+\/)+[\w.\-]*\.\w+(?:-\w+)*|(?:[\w.\-@!]+[\\\/])+[\w.\-]*\.\w+(?:-\w+)*)(?::(\d+)(?:-(\d+))?)?/g;

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
const MENTION_RE = /(?<=^|\s)@\S+/g;

/**
 * Like linkifyPaths, but additionally colors "@path" mentions blue (matching the input box).
 * Non-mention spans are still run through linkifyPaths so absolute paths stay clickable.
 */
export function linkifyWithMentions(text: string): React.ReactNode {
  if (text.length > MAX_LINKIFY_LENGTH) return text;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;

  while ((match = MENTION_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<React.Fragment key={`t${lastIndex}`}>{linkifyPaths(text.slice(lastIndex, match.index))}</React.Fragment>);
    }
    parts.push(<span key={`m${match.index}`} className="mention-path">{match[0]}</span>);
    lastIndex = match.index + match[0].length;
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
