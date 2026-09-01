import React from 'react';
import { plural } from '../utils/text';
import styles from './BackgroundTasksNote.module.css';

interface Props {
  completed?: number;
  total?: number;
}

// Passive footnote on a finished turn whose background tasks outlived it. Deliberately
// static: no spinner, no dots, no ticking timer. Argus cannot tell a build that will
// finish from a browser started for CDP that never will, so anything that animates is
// a claim about the future it has no way to keep - and the task's own notification,
// when it arrives, ends the note by ending the next turn.
export function BackgroundTasksNote({ completed, total }: Props) {
  const known = total != null && total > 0;
  const pending = known ? Math.max(1, total - (completed ?? 0)) : 1;
  const label = known && total > 1
    ? `${pending} of ${total} background tasks still running`
    : `${plural(pending, 'background task')} still running`;

  return (
    <div className={styles.note} data-testid="background-tasks-note" title="The turn is finished. These tasks keep running and will report back when they complete.">
      <span className={styles.glyph}>✻</span>
      <span>{label}</span>
    </div>
  );
}
