import React, { useState, useEffect } from 'react';
import { formatDuration } from '../utils/time';

interface Props {
  startTime: number;
}

export function StreamingTimer({ startTime }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  return <div className="response-time">{formatDuration(now - startTime)}</div>;
}
