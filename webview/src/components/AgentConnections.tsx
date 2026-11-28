import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GraphNode, GraphView } from '../hooks/useAgentGraph';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { agentStatus, statusIcon } from '../utils/agentPresentation';
import styles from './AgentConnections.module.css';
import action from './shared/actionButton.module.css';
import { ProviderIcon } from './shared/ProviderIcon';
const eventLabels: Record<string, string> = { thinking_start: 'Turn started', done: 'Turn finished', error: 'Error', retry_status: 'Retrying',
  interaction: 'Waiting for input', interaction_resolved: 'Input resolved', sessionId: 'Session started', clear: 'Session cleared',
  providerSelection: 'Settings changed', sessionRenamed: 'Session renamed', tool_start: 'Tool started', tool_end: 'Tool finished',
  text_chunk: 'Response updated', user_inject: 'Input received', bgTasks: 'Background work updated' };
function LinkedStatusIcon({ node }: { node: GraphNode }) {
  const label = agentStatus(node);
  return <span className={styles.status} role="img" aria-label={label} title={label}>
    {node.status === 'running' ? <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 2v12l10-6z" /></svg>
      : node.status === 'idle' ? <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 3h3v10H4zm5 0h3v10H9z" /></svg>
      : !node.status ? <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
        <path d="M5 5.5a3 3 0 1 1 4.8 2.4C8.6 8.8 8 9.3 8 10.5m0 2.5h.01" />
      </svg> : statusIcon(node)}
  </span>;
}
interface Props { graph: GraphView; sessionId: string | null; visible: boolean; toggleHost: HTMLElement | null; onOpenSession(workspace: string, id: string): void }
export function AgentConnections({ graph, sessionId, visible, toggleHost, onOpenSession }: Props) {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  const { snapshot, error, loading } = graph;
  const parents = new Set(snapshot?.edges.filter(e => e.kind !== 'peer' && e.to === sessionId).map(e => e.from));
  const parentNodes = snapshot?.nodes.filter(node => parents.has(node.id)) ?? [];
  useEscapeKey(() => {
    const parent = parentNodes[0];
    if (parent) onOpenSession(parent.workspace, parent.id);
  }, { fallback: true });
  if (!sessionId || !visible) return null;
  const children = new Set(snapshot?.edges.filter(e => e.kind !== 'peer' && e.from === sessionId).map(e => e.to));
  const own = snapshot?.nodes.find(n => n.id === sessionId);
  if (snapshot && !parents.size && !children.size && own?.role !== 'coordinator') return null;
  const hasAgents = children.size > 0 || own?.role === 'coordinator';
  const childNodes = snapshot?.nodes.filter(node => children.has(node.id)) ?? [];
  const runningCount = childNodes.filter(node => node.status === 'running').length;
  const toggle = hasAgents && <button type="button" className={styles.toggle}
    aria-label={`Agents, ${runningCount} of ${children.size} running`} aria-expanded={expanded} aria-controls={listId}
    onClick={() => setExpanded(value => !value)}>
    <span aria-hidden="true">{expanded ? '▾' : '▸'} 🤖</span>{' '}
    <span className={runningCount > 0 ? styles.runningCount : undefined}>{runningCount}/{children.size}</span>
  </button>;
  const link = (node: GraphNode) => <button type="button" key={node.id} className={styles.session} data-status={node.status ?? 'unknown'} onClick={() => onOpenSession(node.workspace, node.id)}>
    <span className={styles.title}>
      <ProviderIcon providerId={node.providerId} label size={13} className={styles.provider}
        title={(node.activeSelection ?? node.selected)?.model || 'Model unknown'} />
      <span>{node.title || 'Untitled session'}</span>
    </span>
    <LinkedStatusIcon node={node} />
    {node.pendingInteraction && <span className={`${styles.detail} ${styles.caption}`}>{node.pendingInteraction.questions?.[0]?.question || node.pendingInteraction.title || 'Waiting for input'}</span>}
    {node.lastEventSummary && <span className={styles.detail}>Last: {eventLabels[node.lastEventSummary] || node.lastEventSummary}</span>}
  </button>;
  return <>
    {toggleHost && createPortal(toggle, toggleHost)}
    <section className={styles.panel} aria-label="Linked sessions" aria-live="polite"
      hidden={!!toggleHost && !!snapshot && hasAgents && !expanded && !parents.size && !loading && !error}>
    {loading && <span role="status">Loading linked sessions…</span>}
    {!snapshot && !loading && !error && <span role="status">Waiting for connection…</span>}
    {error && <div className={styles.error}><span role="alert">{error}</span><button className={`${action.button} ${action.secondary}`} type="button" aria-label="Retry linked sessions" onClick={graph.refresh}>Retry</button></div>}
    {parents.size > 0 && <div className={styles.parents}>
      <svg role="img" aria-label="Parents" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <title>Parents</title>
        <path d="M7 8l5-5 5 5M12 3v10m-6 8v-4h12v4m-6-8v4" />
      </svg>
      {parentNodes.map(link)}
    </div>}
    {!toggleHost && toggle}
    {hasAgents && <div id={listId} hidden={!expanded}>
      {!children.size && <p>No children assigned yet.</p>}
      <div className={styles.list}>{childNodes.map(link)}</div>
    </div>}
    </section>
  </>;
}
