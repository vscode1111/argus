import React from 'react';
import { FilePathLink } from '../utils/filePath';
import type { TaskNotice } from '../types';
import styles from './BackgroundNoticeBlock.module.css';

// Opens a turn the user did not start. The CLI runs one of these whenever a background task
// finishes, and until this block there was nothing on screen saying so: a second answer
// simply appeared, did work, and closed with a completion line identical to one that had
// been asked for. The prompt behind it is hidden on purpose (it is XML the CLI wrote to
// itself, not something the user said), so this marker is the only place its reason is told.
export function BackgroundNoticeBlock({ notice }: { notice: TaskNotice }) {
  const label = notice.summary || `Background task ${notice.taskId ?? ''} ${notice.status ?? 'finished'}`.replace(/\s+/g, ' ').trim();

  return (
    <div
      className={styles.notice}
      data-testid="bg-notice"
      title="The CLI started this turn by itself to report a finished background task. You did not send anything."
    >
      <span className={styles.glyph}>✻</span>
      <span className={styles.text}>{label}</span>
      {notice.outputFile && <FilePathLink path={notice.outputFile} display="output" />}
    </div>
  );
}
