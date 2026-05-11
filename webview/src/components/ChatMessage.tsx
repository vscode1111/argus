import React, { useState, useCallback } from 'react';
import { UIMessage, ErrorKind, LoginState } from '../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCall } from './ToolCall';
import { Markdown } from '../utils/markdown';
import { linkifyPaths } from '../utils/filePath';
import { formatDuration, formatTime } from '../utils/time';
import { ImageViewerModal } from './ImageViewerModal';
import { postMessage } from '../vscode';
import msg from './shared/message.module.css';
import styles from './ChatMessage.module.css';

function dispatchLocal(data: object) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

interface Props {
  message: UIMessage;
  login?: LoginState;
}

const ERROR_HINTS: Record<ErrorKind, { title: string; hint: string }> = {
  auth: {
    title: 'Authentication required',
    hint: 'Run `claude login` in your terminal to authenticate, then retry.',
  },
  not_found: {
    title: 'Claude CLI not found',
    hint: 'Install it with: npm install -g @anthropic-ai/claude-code',
  },
  session: {
    title: 'Session expired',
    hint: 'The previous session could not be restored. Start a new session or retry.',
  },
  generic: {
    title: 'Something went wrong',
    hint: 'Check the log panel for details.',
  },
};

function LoginPanel({ login }: { login: LoginState }) {
  const [code, setCode] = useState('');
  const phase = login.phase;

  if (phase === 'starting') {
    return <div className={styles.loginPanel}><div className={styles.loginHint}>Starting login...</div></div>;
  }

  if (phase === 'url') {
    return (
      <div className={styles.loginPanel}>
        <div className={styles.loginTitle}>Continue in browser</div>
        <div className={styles.loginHint}>If the browser didn't open, visit this URL:</div>
        <div className={styles.loginUrlRow}>
          <input className={styles.loginUrlInput} value={login.url} readOnly onClick={e => (e.target as HTMLInputElement).select()} />
          <button className={styles.loginCopyBtn} onClick={() => navigator.clipboard.writeText(login.url)} title="Copy URL">&#128203;</button>
          <button className={styles.loginCopyBtn} onClick={() => { postMessage({ type: 'openUrl', url: login.url }); window.open(login.url, '_blank'); }} title="Open in browser">&#8599;</button>
        </div>
        <div className={styles.loginHint}>Or, paste your authorization code manually:</div>
        <input
          className={styles.loginCodeInput}
          placeholder="012345"
          value={code}
          onChange={e => setCode(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && code.trim()) { dispatchLocal({ type: 'loginSubmitting' }); postMessage({ type: 'loginCode', text: code.trim() }); } }}
        />
        <div className={styles.errorActions}>
          <button className={styles.loginContinueBtn} disabled={!code.trim()} onClick={() => { dispatchLocal({ type: 'loginSubmitting' }); postMessage({ type: 'loginCode', text: code.trim() }); }}>Continue</button>
        </div>
      </div>
    );
  }

  if (phase === 'submitting') {
    return <div className={styles.loginPanel}><div className={styles.loginHint}>Authenticating...</div></div>;
  }

  if (phase === 'success') {
    return (
      <div className={styles.loginPanel}>
        <div className={styles.loginSuccess}>Login successful</div>
        <div className={styles.errorActions}>
          <button className={styles.errorBtn} onClick={() => postMessage({ type: 'retry' })}>Retry</button>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className={styles.loginPanel}>
        <div className={styles.errorTitle}>{login.message}</div>
        <div className={styles.errorActions}>
          <button className={styles.errorBtn} onClick={() => { dispatchLocal({ type: 'loginStart' }); postMessage({ type: 'login' }); }}>Try again</button>
        </div>
      </div>
    );
  }

  return null;
}

function ErrorMessage({ message, login }: Props) {
  const { content, errorKind = 'generic' } = message;
  const { title, hint } = ERROR_HINTS[errorKind];
  const showLoginPanel = errorKind === 'auth' && login && login.phase !== 'idle';
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  return (
    <div className={[msg.message, msg.assistant, styles.errorBlock].join(' ')}>
      <div className={styles.errorTitle}>{title}</div>
      {content && <div className={styles.errorDetail}>{content}</div>}
      {showLoginPanel ? (
        <LoginPanel login={login} />
      ) : (
        <>
          <div className={styles.errorHint}>{hint}</div>
          <div className={styles.errorActions}>
            {errorKind === 'auth' && (
              <button className={styles.loginContinueBtn} onClick={() => { dispatchLocal({ type: 'loginStart' }); postMessage({ type: 'login' }); }}>Login</button>
            )}
            <button className={styles.errorBtn} onClick={() => { setHidden(true); postMessage({ type: 'retry' }); }}>Retry</button>
            {errorKind === 'session' && (
              <button className={styles.errorBtn} onClick={() => postMessage({ type: 'newSession' })}>New session</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function ChatMessage({ message, login }: Props) {
  const { role, content, thinking, blocks, responseTime } = message;
  const [retryHidden, setRetryHidden] = useState(false);

  if (role === 'error') {
    return <ErrorMessage message={message} login={login} />;
  }

  if (role === 'user') {
    return <UserMessage message={message} />;
  }

  // Hide text blocks after a pending AskUserQuestion so the AI appears to wait
  const firstPendingAskIdx = blocks?.findIndex(
    b => b.type === 'tool' && b.call.name === 'AskUserQuestion' && !b.call.result
  ) ?? -1;

  const showRetryBtn = message.watchdogRetries && !retryHidden;

  return (
    <div className={[msg.message, msg.assistant].join(' ')}>
      {thinking && <ThinkingBlock text={thinking} />}
      {blocks ? blocks.map((block, i) => {
        if (firstPendingAskIdx >= 0 && i > firstPendingAskIdx && block.type === 'text') {
          return null;
        }
        return block.type === 'tool'
          ? <ToolCall key={block.call.id} call={block.call} />
          : <div key={`text-${i}`} className={msg.messageContent}>
              <Markdown>{block.text}</Markdown>
            </div>;
      }) : content && (
        <div className={msg.messageContent}>
          <Markdown>{content}</Markdown>
        </div>
      )}
      {responseTime !== undefined && (
        <div className={
          message.outcome === 'error' ? msg.responseTimeError
          : message.outcome === 'stopped' ? msg.responseTimeStopped
          : message.outcome === 'retried' ? msg.responseTimeRetried
          : msg.responseTimeSuccess
        }>
          {message.watchdogRetries ? `Watchdog: retried ${message.watchdogRetries}x. ` : ''}
          {formatDuration(responseTime)}{message.finishedAt ? ` (${formatTime(message.finishedAt)})` : ''}
          {showRetryBtn && (
            <button className={styles.retryBtn} onClick={() => { setRetryHidden(true); postMessage({ type: 'retry' }); }}>Retry</button>
          )}
        </div>
      )}
    </div>
  );
}

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
      className={styles.msgCopyBtn}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

function UserMessage({ message }: Props) {
  const { content } = message;
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  return (
    <div className={[msg.message, msg.user, styles.userMsg].join(' ')}>
      <div className={msg.messageContent} style={{ whiteSpace: 'pre-wrap' }}>{content ? linkifyPaths(content) : content}</div>
      {content && <MessageCopyButton text={content} />}
      {message.images && message.images.length > 0 && (
        <div className={styles.messageImages}>
          {message.images.map((img, i) => (
            <img key={i} src={`data:${img.mediaType};base64,${img.data}`} alt={`Attachment ${i + 1}`} className={styles.messageImage} onClick={() => setViewerIndex(i)} />
          ))}
        </div>
      )}
      {viewerIndex !== null && message.images?.[viewerIndex] && (
        <ImageViewerModal
          src={`data:${message.images[viewerIndex].mediaType};base64,${message.images[viewerIndex].data}`}
          alt={`Attachment ${viewerIndex + 1}`}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </div>
  );
}
