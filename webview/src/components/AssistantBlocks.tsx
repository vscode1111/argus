import React from 'react';
import { ContentBlock } from '../types';
import { useSettings } from '../contexts/SettingsContext';
import { Markdown } from '../utils/markdown';
import { BackgroundNoticeBlock } from './BackgroundNoticeBlock';
import { isNameOnlyTool, ToolCall } from './ToolCall';
import { UserInjectBlock } from './UserInjectBlock';
import msg from './shared/message.module.css';

interface Props {
  blocks: ContentBlock[];
  sessionDone?: boolean;
}

export function AssistantBlocks({ blocks, sessionDone }: Props) {
  const { showOutput, verboseTools } = useSettings();
  const firstPendingAsk = blocks.findIndex(
    block => block.type === 'tool' && block.call.name === 'AskUserQuestion' && !block.call.result
  );
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === 'tool') {
      const start = index;
      let call = block.call;
      if (!verboseTools && isNameOnlyTool(call, showOutput)) {
        while (index + 1 < blocks.length) {
          const next = blocks[index + 1];
          if (next.type !== 'tool' || next.call.name !== call.name || !isNameOnlyTool(next.call, showOutput)) break;
          if (!next.call.result) call = next.call;
          index++;
        }
      }
      rendered.push(<ToolCall key={block.call.id} call={call} count={index - start + 1} sessionDone={sessionDone} />);
    } else if (block.type === 'user_inject') {
      rendered.push(<UserInjectBlock key={`inject-${index}`} text={block.text} images={block.images} />);
    } else if (block.type === 'bg_notice') {
      rendered.push(<BackgroundNoticeBlock key={`notice-${index}`} notice={block.notice} />);
    } else if (firstPendingAsk < 0 || index <= firstPendingAsk) {
      rendered.push(<div key={`text-${index}`} className={msg.messageContent}><Markdown>{block.text}</Markdown></div>);
    }
  }
  return <>{rendered}</>;
}
