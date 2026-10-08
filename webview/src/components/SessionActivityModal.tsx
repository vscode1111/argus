import React, { useEffect, useState } from 'react';
import type { UIMessage } from '../types';
import type { SessionActivity } from '../utils/sessionActivity';
import { postMessage } from '../vscode';
import { ChatMessage } from './ChatMessage';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import { BackIcon } from './shared/icons';
import styles from './SessionActivityModal.module.css';

interface Props {
  parentId: string | null;
  activity: SessionActivity;
  onClose: () => void;
}

interface WorkspaceChanges {
  added: number;
  removed: number;
  isIncomplete: boolean;
  error?: string;
}

function agentLabel(path: string): string {
  const name = path.split('/').filter(Boolean).pop() || path;
  return name.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
}

export function SessionActivityModal({ parentId, activity, onClose }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[] | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [remoteAgents, setRemoteAgents] = useState<SessionActivity['agents'] | null>(null);
  const [activityError, setActivityError] = useState('');
  const agents = [...new Map([...activity.agents, ...(remoteAgents ?? [])].map(value => [value.id, value])).values()]
    .sort((a, b) => Number(b.active) - Number(a.active));
  const agent = agents.find(value => value.id === selected);
  const loadingAgents = !!parentId && remoteAgents === null && !activityError;
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'workspaceChanges') setChanges(data);
    };
    window.addEventListener('message', receive);
    postMessage({ type: 'getWorkspaceChanges' });
    const timer = window.setInterval(() => postMessage({ type: 'getWorkspaceChanges' }), 5000);
    return () => { window.removeEventListener('message', receive); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!parentId) return;
    let deadline: number | undefined;
    const request = () => {
      postMessage({ type: 'getSessionActivity', id: parentId });
      if (deadline) window.clearTimeout(deadline);
      deadline = window.setTimeout(() => setActivityError('Activity unavailable. Update or restart the Argus server.'), 4000);
    };
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== 'sessionActivity' || data.parentId !== parentId) return;
      if (deadline) window.clearTimeout(deadline);
      deadline = undefined;
      if (typeof data.error === 'string') setActivityError(data.error);
      else if (Array.isArray(data.agents)) { setRemoteAgents(data.agents); setActivityError(''); }
    };
    window.addEventListener('message', receive);
    request();
    const interval = window.setInterval(request, 15000);
    return () => { window.removeEventListener('message', receive); window.clearInterval(interval); if (deadline) window.clearTimeout(deadline); };
  }, [parentId]);
  useEffect(() => {
    if (!selected) return;
    setMessages(null); setError('');
    if (!parentId) { setError('Conversation ID is not available yet.'); return; }
    const deadline = window.setTimeout(() => setError('Transcript unavailable. Update or restart the Argus server.'), 4000);
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== 'subagentThread' || data.parentId !== parentId || data.childId !== selected) return;
      window.clearTimeout(deadline);
      if (typeof data.error === 'string') setError(data.error);
      else if (Array.isArray(data.messages)) setMessages(data.messages);
    };
    window.addEventListener('message', receive);
    postMessage({ type: 'getSubagentThread', id: parentId, childId: selected });
    return () => { window.removeEventListener('message', receive); window.clearTimeout(deadline); };
  }, [parentId, selected, refresh]);

  return <Modal key={agent ? 'agent' : 'summary'} title={agent ? <span className={styles.titleWithBack}><button className={styles.backButton} onClick={() => setSelected(null)} onPointerDown={event => event.stopPropagation()} title="All activity" aria-label="All activity"><BackIcon size={14} /></button><span className={styles.agentTitle}>{agentLabel(agent.path)}</span></span> : 'Session activity'} ariaLabel="Session activity" onClose={onClose} onEscape={agent ? () => setSelected(null) : onClose} width={620} fullHeight={!!agent} persistKey={agent ? 'sessionActivityTranscript' : 'sessionActivityList'}
    headerClassName={styles.centeredHeader}
    headerActions={agent && <RefreshButton spinning={messages === null && !error} onClick={() => { setMessages(null); setRefresh(value => value + 1); }} label="Refresh transcript" title="Refresh transcript" />}>
    <div className={[styles.body, agent && styles.agentBody].filter(Boolean).join(' ')}>
      {agent ? <>
        <div className={styles.agentStatus}>{agent.path} · {agent.active ? 'Active' : 'Completed'}</div>
        {error && <div role="alert" className={styles.error}>{error}</div>}
        {!error && !messages && <div role="status" className={styles.loading}><span className={styles.spinner} aria-hidden="true" />Loading transcript…</div>}
        {messages?.length === 0 && <div className={styles.empty}>No transcript items yet.</div>}
        {messages?.map(message => <ChatMessage key={message.id} message={message} />)}
      </> : <>
        {activityError && <div role="alert" className={styles.error}>{activityError}</div>}
        <div className={styles.summary}>
          <span>Workspace changes</span>
          {changes?.error ? <span className={styles.error}>Git diff unavailable</span>
            : changes ? <span className={styles.counts} title={changes.isIncomplete ? 'Some large or binary untracked files were skipped' : undefined}>{changes.isIncomplete ? 'At least ' : ''}<span className={styles.added}>+{changes.added}</span> <span className={styles.removed}>-{changes.removed}</span></span>
            : <span className={styles.loading} role="status" aria-label="Loading workspace changes"><span className={styles.spinner} aria-hidden="true" /></span>}
        </div>
        <div className={styles.sectionTitle}>Subagents · {agents.length}{loadingAgents && <span className={styles.loading} role="status" aria-label="Loading subagents"><span className={styles.spinner} aria-hidden="true" /></span>}</div>
        {loadingAgents && agents.length === 0 && <div aria-hidden="true">{[0, 1].map(index => <div key={index} className={styles.skeletonRow}><span className={styles.skeletonDot} /><span className={styles.skeletonName} /><span className={styles.skeletonStatus} /></div>)}</div>}
        {agents.length === 0 && !loadingAgents && <div className={styles.empty}>No subagents</div>}
        {agents.map(value => <button key={value.id} className={styles.agent} onClick={() => setSelected(value.id)}><span className={value.active ? styles.activeDot : styles.completeDot} />{agentLabel(value.path)}<span className={styles.status}>{value.active ? 'Active' : 'Completed'}</span></button>)}
      </>}
    </div>
  </Modal>;
}
