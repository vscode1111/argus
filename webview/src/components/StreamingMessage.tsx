import React from 'react';
import { StreamingState } from '../types';
import { ThinkingBlock } from './ThinkingBlock';
import { AssistantBlocks } from './AssistantBlocks';
import { StreamingTimer } from './StreamingTimer';
import { WorkingIndicator } from './WorkingIndicator';
import { useSettings } from '../contexts/SettingsContext';
import msg from './shared/message.module.css';

interface Props {
  streaming: StreamingState;
  logCount: number;
}

export function StreamingMessage({ streaming, logCount }: Props) {
  const { showTimer } = useSettings();
  const { thinking, blocks, startTime, lastEventTime, logsAtStart, reused, liveTokens } = streaming;
  const isEmpty = !thinking && blocks.length === 0;
  // New session: trigger after the first CLI event past "stdin" (newLogs > 1)
  // Reused process: wait one more event so the indicator doesn't appear instantly (newLogs > 2)
  const newLogs = logCount - logsAtStart;
  const threshold = reused ? 2 : 1;
  const showWorking = isEmpty && newLogs > threshold;

  return (
    <div className={[
      msg.message,
      msg.assistant,
      msg.streaming,
      isEmpty && msg.empty,
    ].filter(Boolean).join(' ')}>
      {thinking && <ThinkingBlock text={thinking} />}
      {showWorking && !streaming.retryStatus && <WorkingIndicator logCount={logCount} />}
      <AssistantBlocks blocks={blocks} />
      {streaming.retryStatus && <WorkingIndicator logCount={logCount} retryStatus={streaming.retryStatus} />}
      {showTimer && <StreamingTimer startTime={startTime} lastEventTime={lastEventTime} hideIdle={!!streaming.askPausedAt} liveTokens={liveTokens} />}
    </div>
  );
}
