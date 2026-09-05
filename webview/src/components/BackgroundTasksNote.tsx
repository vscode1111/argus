import React from 'react';
import { plural } from '../utils/text';
import styles from './BackgroundTasksNote.module.css';

interface Props {
  pending?: number;
}

// Passive footnote on a finished turn whose background tasks outlived it. Deliberately
// static: no spinner, no dots, no ticking timer. Argus cannot tell a build that will
// finish from a browser started for CDP that never will, so anything that animates is
// a claim about the future it has no way to keep - and the task's own notification,
// when it arrives, ends the note by ending the next turn.
//
// Deliberately no denominator: this said "2 of 9 background tasks still running" on a
// turn that launched exactly two, because the total counted every `task_started` since
// the last counter reset, and resets happen per user send while the tasks themselves
// outlive turns. "of 9" invites the reader to conclude seven finished, which is not a
// fact Argus holds. The pending count is the live set and is the only number here with
// a name the reader can state. It still undercounts a task that outlived its own turn
// (the per-turn reset is what garbage-collects orphans whose notification never lands),
// so it is a footnote, not an inventory. See !notes/tasks/bg-task-indicators/notes.md.
export function BackgroundTasksNote({ pending }: Props) {
  const count = pending != null && pending > 0 ? pending : 1;
  const label = `${plural(count, 'background task')} still running`;

  return (
    <div className={styles.note} data-testid="background-tasks-note" title="The turn is finished. These tasks keep running and will report back when they complete.">
      <span className={styles.glyph}>✻</span>
      <span>{label}</span>
    </div>
  );
}
