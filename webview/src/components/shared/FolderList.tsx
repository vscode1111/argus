import React from 'react';
import { fileIconFor, ICON_COLORS, IconKind } from '../../utils/fileIcon';
import styles from './folderList.module.css';

/**
 * The folder-explorer row, shared by the Workspace History "Browse" tab and the
 * directory preview in FileViewerModal. Same visual form in both: an icon, a name
 * that ellipsises, and an optional right-aligned meta column.
 *
 * The class names are deliberately unchanged from the Browse tab's own module -
 * the e2e specs locate rows by `[class*="browseName"]`, and a CSS-module local name
 * survives into the generated class.
 */

export function FolderIcon() {
  return (
    <svg className={styles.folderIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// The glyph bodies, drawn in the same 24x24 stroke style as the folder and back icons
// so the listing keeps one visual language. Kept few and simple deliberately: rendered
// at 15px, a gear or a database with any detail turns to mush, and in a list it is the
// colour that the eye actually sorts by.
const GLYPHS: Record<IconKind, React.ReactNode> = {
  doc: <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </>,
  code: <>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </>,
  braces: <>
    <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
    <path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
  </>,
  image: <>
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </>,
  archive: <>
    <polyline points="21 8 21 21 3 21 3 8" />
    <rect x="1" y="3" width="22" height="5" rx="1" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </>,
  config: <>
    <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </>,
  shell: <>
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </>,
  db: <>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
  </>,
};

/** The plain document glyph, for callers with no filename to key on. */
export function FileIcon() {
  return (
    <svg className={styles.fileIcon} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS.doc}
    </svg>
  );
}

/**
 * A file's icon, picked from its name the way VS Code's default theme does it.
 * The colour is inline rather than a class: it comes from a fixed palette keyed by
 * file type, not from the panel theme, so there is nothing for a stylesheet to decide.
 */
export function FileTypeIcon({ name }: { name: string }) {
  const { kind, color } = fileIconFor(name);
  return (
    <svg
      className={styles.fileIcon}
      style={{ color: ICON_COLORS[color] }}
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={kind}
    >
      {GLYPHS[kind]}
    </svg>
  );
}

function UpIcon() {
  return (
    <svg className={styles.upIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

interface RowProps {
  icon?: React.ReactNode;
  name: string;
  /** Right-aligned secondary column (a file size, a count). */
  meta?: React.ReactNode;
  title?: string;
  className?: string;
  onClick: () => void;
}

export function BrowseRow({ icon, name, meta, title, className, onClick }: RowProps) {
  return (
    <div
      className={[styles.browseRow, className].filter(Boolean).join(' ')}
      onClick={onClick}
      title={title}
    >
      {icon}
      <span className={styles.browseName}>{name}</span>
      {meta != null && <span className={styles.rowMeta}>{meta}</span>}
    </div>
  );
}

/** "Up one level" row; the caller decides where up is. */
export function UpRow({ onClick }: { onClick: () => void }) {
  return <BrowseRow icon={<UpIcon />} name="Up" onClick={onClick} />;
}

/** Compact byte size for a listing column - "812 B", "4.1 KB", "2.3 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
