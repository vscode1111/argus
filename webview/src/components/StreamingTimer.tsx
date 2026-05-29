import React, { useState, useEffect } from 'react';
import { formatDuration } from '../utils/time';
import msg from './shared/message.module.css';

interface Props {
  startTime: number;
  lastEventTime: number;
  hideIdle?: boolean;
}

export function StreamingTimer({ startTime, lastEventTime, hideIdle }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const total = formatDuration(now - startTime);
  const idle = Math.floor((now - lastEventTime) / 1000);

  return (
    <div className={msg.responseTime}>
      {total}{!hideIdle && idle > 0 ? ` (${idle}s)` : ''}
    </div>
  );
}
