import React, { useEffect, useState } from 'react';
import { plural } from '../utils/text';
import { formatDuration } from '../utils/time';
import styles from './BackgroundTasksNote.module.css';

interface Props {
  pending?: number;
  /** When the oldest still-running task was launched. */
  since?: number;
}

// Passive footnote on a finished turn whose background tasks outlived it. No spinner and no
// dots: Argus cannot tell a build that will finish from a browser started for CDP that never
// will, so anything suggesting progress towards an end is a claim about the future it has no
// way to keep - the task's own notification, when it arrives, ends the note by ending the
// next turn.
//
// The elapsed time is the one exception, and it is not that kind of claim: it counts up from
// a launch that already happened and promises nothing about a finish. It exists because the
// turn timer beside it is frozen by design - 57s is how long *the turn* took - so a 45-minute
// CI poller left the whole screen looking stopped, and the reported session shows the user
// asking "текущий статус CI" by hand six minutes in rather than being able to read it.
//
// Deliberately no denominator: this said "2 of 9 background tasks still running" on a
// turn that launched exactly two, because the total counted every `task_started` since
// the last counter reset, and resets happen per user send while the tasks themselves
// outlive turns. "of 9" invites the reader to conclude seven finished, which is not a
// fact Argus holds. The pending count is the live set and is the only number here with
// a name the reader can state. It still undercounts a task that outlived its own turn
// (the per-turn reset is what garbage-collects orphans whose notification never lands),
// so it is a footnote, not an inventory. See !notes/tasks/bg-task-indicators/notes.md.
export function BackgroundTasksNote({ pending, since }: Props) {
  const count = pending != null && pending > 0 ? pending : 1;
  const label = `${plural(count, 'background task')} still running`;
  // Ticks only while there is a launch time to count from, so an older daemon that does not
  // send one renders the note exactly as before instead of a clock starting at zero.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);

  return (
    <div className={styles.note} data-testid="background-tasks-note" title="The turn is finished. These tasks keep running and will report back when they complete.">
      <span className={styles.glyph}>✻</span>
      <span>{label}</span>
      {since && <span className={styles.elapsed} data-testid="background-tasks-elapsed">{formatDuration(Math.max(0, now - since))}</span>}
    </div>
  );
}
