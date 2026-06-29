import React, { useState, useEffect } from 'react';
import { formatDuration } from '../utils/time';
import msg from './shared/message.module.css';

interface Props {
  startTime: number;
  lastEventTime: number;
  hideIdle?: boolean;
  liveTokens?: { input: number; output: number };
}

function fmtTok(n: number): string {
  return n.toLocaleString();
}

export function StreamingTimer({ startTime, lastEventTime, hideIdle, liveTokens }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const total = formatDuration(now - startTime);
  const idle = Math.floor((now - lastEventTime) / 1000);
  const hasTokens = liveTokens && (liveTokens.input > 0 || liveTokens.output > 0);

  return (
    <div className={msg.responseTime}>
      {total}{!hideIdle && idle > 0 ? ` (${idle}s)` : ''}
      {hasTokens && (
        <>
          {' · '}
          {liveTokens!.output > 0 && fmtTok(liveTokens!.output) + ' out'}
          {liveTokens!.output > 0 && liveTokens!.input > 0 && ' / '}
          {liveTokens!.input > 0 && fmtTok(liveTokens!.input) + ' in'}
        </>
      )}
    </div>
  );
}
