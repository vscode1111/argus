import React, { useEffect, useState } from 'react';
import type { RetryStatus } from '../types';
import { formatDuration } from '../utils/time';
import msg from './shared/message.module.css';
import styles from './WorkingIndicator.module.css';

const VERBS = [
  'Envisioning', 'Pondering', 'Cogitating', 'Reflecting', 'Mulling',
  'Considering', 'Analyzing', 'Examining', 'Exploring', 'Reasoning',
  'Thinking', 'Processing', 'Brewing', 'Brainstorming', 'Conjuring',
  'Contemplating', 'Deliberating', 'Musing', 'Ruminating', 'Synthesizing',
  'Formulating', 'Crafting', 'Composing', 'Devising', 'Imagining',
  'Hatching', 'Percolating', 'Simmering', 'Distilling', 'Refining',
  'Tinkering', 'Forging', 'Sculpting', 'Building', 'Constructing',
  'Weaving', 'Searching', 'Surveying', 'Mapping', 'Decoding',
  'Deciphering', 'Solving', 'Puzzling', 'Wondering', 'Speculating',
  'Hypothesizing', 'Theorizing', 'Calculating', 'Computing', 'Estimating',
  'Weighing', 'Juggling', 'Pulsing', 'Humming', 'Bustling',
  'Scrambling', 'Hustling', 'Surging', 'Soaring', 'Climbing',
  'Generating', 'Producing', 'Cultivating', 'Tending', 'Plotting',
  'Charting', 'Scouting', 'Foraging', 'Marinating', 'Stewing',
];

function pickVerb(prev?: string): string {
  if (VERBS.length <= 1) return VERBS[0];
  let v = prev;
  while (v === prev) v = VERBS[Math.floor(Math.random() * VERBS.length)];
  return v!;
}

interface Props {
  logCount: number;
  retryStatus?: RetryStatus | null;
  backgroundWaiting?: boolean;
  bgTasksCompleted?: number;
  bgTasksTotal?: number;
  startTime?: number;
  lastEventTime?: number;
}

export function WorkingIndicator({ logCount, retryStatus, backgroundWaiting, bgTasksCompleted, bgTasksTotal, startTime, lastEventTime }: Props) {
  const [verb, setVerb] = useState<string>(() => pickVerb());
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setVerb(prev => pickVerb(prev));
  }, [logCount]);

  useEffect(() => {
    const dotsId = setInterval(() => setTick(t => t + 1), 400);
    return () => clearInterval(dotsId);
  }, []);

  useEffect(() => {
    if (startTime == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startTime]);

  const dotCount = (tick % 3) + 1;
  const dots = '.'.repeat(dotCount);

  let label: string;
  if (backgroundWaiting) {
    const plural = bgTasksTotal != null && bgTasksTotal > 1;
    const counter = plural ? ` (${bgTasksCompleted ?? 0}/${bgTasksTotal})` : '';
    label = `Waiting background ${plural ? 'tasks' : 'task'}${counter}`;
  } else if (retryStatus?.timedOut) {
    label = 'Timed out, press Stop';
  } else if (retryStatus?.autoRetry != null) {
    label = `Reconnecting (${retryStatus.autoRetry}/${retryStatus.autoRetryMax ?? 3})`;
  } else if (retryStatus) {
    label = `Retrying (${retryStatus.attempt}/${retryStatus.maxRetries})`;
  } else {
    label = verb;
  }

  const showTimer = backgroundWaiting && startTime != null;
  const total = showTimer ? formatDuration(now - startTime!) : '';
  const idle = showTimer && lastEventTime ? Math.floor((now - lastEventTime) / 1000) : 0;

  return (
    <>
      <div className={[styles.working, retryStatus ? styles.retrying : ''].filter(Boolean).join(' ')} aria-live="polite">
        <span className={styles.asterisk}>✻</span>
        <span className={styles.verb}>{label}</span>
        <span className={styles.dots}>{dots}</span>
      </div>
      {showTimer && <div className={msg.responseTime}>{total}{idle > 0 ? ` (${idle}s)` : ''}</div>}
    </>
  );
}
