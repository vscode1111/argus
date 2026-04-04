import React, { useState } from 'react';

interface Props {
  text: string;
}

export function ThinkingBlock({ text }: Props) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`thinking-block${expanded ? ' expanded' : ''}`}
      onClick={() => setExpanded(e => !e)}
    >
      {text}
    </div>
  );
}
