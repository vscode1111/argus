import React from 'react';
import { StreamingState } from '../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCall } from './ToolCall';
import { Markdown } from '../utils/markdown';
import { StreamingTimer } from './StreamingTimer';
import { useSettings } from '../contexts/SettingsContext';
import msg from './shared/message.module.css';

interface Props {
  streaming: StreamingState;
}

export function StreamingMessage({ streaming }: Props) {
  const { showTimer } = useSettings();
  const { thinking, blocks, startTime, lastEventTime } = streaming;
  const isEmpty = !thinking && blocks.length === 0;

  return (
    <div className={[
      msg.message,
      msg.assistant,
      msg.streaming,
      isEmpty && msg.empty,
    ].filter(Boolean).join(' ')}>
      {thinking && <ThinkingBlock text={thinking} />}
      {blocks.map((block, i) =>
        block.type === 'tool'
          ? <ToolCall key={block.call.id} call={block.call} />
          : <div key={`text-${i}`} className={msg.messageContent}>
              <Markdown>{block.text}</Markdown>
            </div>
      )}
      {showTimer && <StreamingTimer startTime={startTime} lastEventTime={lastEventTime} />}
    </div>
  );
}
