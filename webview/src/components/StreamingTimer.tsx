import React, { useState, useEffect } from 'react';
import { formatDuration } from '../utils/time';

interface Props {
  startTime: number;
  lastEventTime: number;
}

export function StreamingTimer({ startTime, lastEventTime }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const total = formatDuration(now - startTime);
  const idle = Math.floor((now - lastEventTime) / 1000);

  return (
    <div className="response-time">
      {total}{idle > 0 ? ` (${idle}s)` : ''}
    </div>
  );
}
