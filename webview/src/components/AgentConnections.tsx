import type { GraphNode, GraphView } from '../hooks/useAgentGraph';
import styles from './AgentConnections.module.css';
export const agentStatus = (node?: GraphNode) => node?.status ? ({ 'needs-input': 'Needs input', running: 'Running', idle: 'Idle', error: 'Error', stopped: 'Stopped' }[node.status] || node.status) : 'Unknown';
const eventLabels: Record<string, string> = { thinking_start: 'Turn started', done: 'Turn finished', error: 'Error', retry_status: 'Retrying',
  interaction: 'Waiting for input', interaction_resolved: 'Input resolved', sessionId: 'Session started', clear: 'Session cleared',
  providerSelection: 'Settings changed', sessionRenamed: 'Session renamed', tool_start: 'Tool started', tool_end: 'Tool finished',
  text_chunk: 'Response updated', user_inject: 'Input received', bgTasks: 'Background work updated' };
interface Props { graph: GraphView; sessionId: string | null; onOpenSession(workspace: string, id: string): void }
export function AgentConnections({ graph, sessionId, onOpenSession }: Props) {
  if (!sessionId) return null;
  const { snapshot, error, loading } = graph;
  const parents = new Set(snapshot?.edges.filter(e => e.kind !== 'peer' && e.to === sessionId).map(e => e.from));
  const children = new Set(snapshot?.edges.filter(e => e.kind !== 'peer' && e.from === sessionId).map(e => e.to));
  const own = snapshot?.nodes.find(n => n.id === sessionId);
  if (snapshot && !parents.size && !children.size && own?.role !== 'coordinator') return null;
  const link = (node: GraphNode) => <button type="button" key={node.id} className={styles.session} onClick={() => onOpenSession(node.workspace, node.id)}>
    <span className={styles.title}>{node.title || 'Untitled session'}</span><span className={styles.status}>{agentStatus(node)}</span>
    {node.pendingInteraction && <span className={styles.detail}>{node.pendingInteraction.questions?.[0]?.question || node.pendingInteraction.title || 'Waiting for input'}</span>}
    {node.lastEventSummary && <span className={styles.detail}>Last: {eventLabels[node.lastEventSummary] || node.lastEventSummary}</span>}
  </button>;
  return <section className={styles.panel} aria-label="Linked sessions" aria-live="polite">
    {loading && <span role="status">Loading linked sessions…</span>}
    {!snapshot && !loading && !error && <span role="status">Waiting for connection…</span>}
    {error && <><span role="alert">{error}</span><button type="button" aria-label="Retry linked sessions" onClick={graph.refresh}>Retry</button></>}
    {parents.size > 0 && <div className={styles.parents}><span>Parents</span>{snapshot?.nodes.filter(n => parents.has(n.id)).map(link)}</div>}
    {(children.size > 0 || own?.role === 'coordinator') && <details open className={styles.children}>
      <summary>Agents · {children.size}</summary>
      {!children.size && <p>No children assigned yet.</p>}
      <div className={styles.list}>{snapshot?.nodes.filter(n => children.has(n.id)).map(link)}</div>
    </details>}
  </section>;
}
