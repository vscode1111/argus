import type { GraphView } from '../hooks/useAgentGraph';
import { agentStatus } from '../utils/agentPresentation';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import styles from './OrchestratorGoalsModal.module.css';

interface Props {
  graph: GraphView;
  onClose: () => void;
  onOpenSession: (workspace: string, sessionId: string) => void;
}
export function OrchestratorGoalsModal({ graph, onClose, onOpenSession }: Props) {
  const { snapshot, loading, error, refresh } = graph;
  const goals = snapshot?.scopes.filter(scope => scope.data).map(scope => {
    const data = scope.data!;
    const workers = Object.entries(data.workers).map(([key, worker]) => ({ ...worker, key, node: snapshot.nodes.find(n => n.id === worker.sessionId) }));
    const members = new Set(workers.map(w => w.sessionId));
    const coordinators = snapshot.nodes.filter(n => n.role === 'coordinator' && (n.company === scope.company && n.goal === scope.goal
      || snapshot.edges.some(e => e.kind !== 'peer' && e.from === n.id && members.has(e.to))));
    return { ...scope, ...data.goal, workers, coordinators };
  });
  const open = (workspace: string, id: string) => { onOpenSession(workspace, id); onClose(); };
  return <Modal title="Company goals" ariaLabel="Company goals" onClose={onClose} width={640}
    headerActions={<RefreshButton spinning={loading} onClick={refresh} label="Refresh goals" title="Refresh goals" />}>
    <div className={styles.body}>
      {error && <p role="alert">{error}</p>}
      {!snapshot && !error && <p role="status">{loading ? 'Loading goals…' : 'Waiting for connection…'}</p>}
      {goals?.length === 0 && <p>No company goals yet. Start one with $orchestrate.</p>}
      {goals?.map(goal => <section key={`${goal.company}/${goal.goal}`} className={styles.goal} aria-label={`${goal.company}: ${goal.title}`}>
        <div className={styles.goalHeader}>
          <div><strong>{goal.title}</strong><span className={styles.company}>{goal.company} · {goal.profile}</span></div>
          <span className={styles.status}>{goal.status}</span>
        </div>
        {goal.coordinators.map(coordinator => <button key={coordinator.id} type="button" className={styles.worker}
          onClick={() => open(coordinator.workspace, coordinator.id)}>
          <strong className={styles.workerName}>Coordinator · {coordinator.title || 'Untitled session'}</strong>
          <span className={styles.status}>{agentStatus(coordinator)}</span>
        </button>)}
        {!goal.coordinators.length && <p className={styles.empty}>No coordinator assigned.</p>}
        {goal.workers.length === 0 && <p className={styles.empty}>No sessions assigned yet.</p>}
        {goal.workers.map(worker => <button key={worker.key} type="button" className={styles.worker}
          disabled={!worker.sessionId} title={worker.sessionId ? `Open ${worker.title}` : 'Session has not started yet'}
          onClick={() => { if (worker.sessionId) open(worker.workspace, worker.sessionId); }}>
          <span className={styles.workerName}>{worker.node?.title || worker.title || worker.key}</span>
          <span className={styles.details}>{[worker.providerId, worker.model].filter(Boolean).join(' · ')}</span>
          <span className={styles.status}>{worker.sessionId ? agentStatus(worker.node) : 'Not started'}</span>
        </button>)}
      </section>)}
    </div>
  </Modal>;
}
