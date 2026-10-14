import { useEffect, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import { Modal } from './shared/Modal';
import { RefreshButton } from './shared/RefreshButton';
import styles from './OrchestratorGoalsModal.module.css';

interface Worker {
  key: string;
  title: string;
  status: string;
  sessionId?: string;
  workspace: string;
  providerId?: string;
  model?: string;
}

interface Goal {
  company: string;
  goal: string;
  title: string;
  status: string;
  workers: Worker[];
}

interface Props {
  onClose: () => void;
  onOpenSession: (workspace: string, sessionId: string) => void;
}

export function OrchestratorGoalsModal({ onClose, onOpenSession }: Props) {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [error, setError] = useState('');
  const timeout = useRef<number | undefined>(undefined);
  const refresh = () => {
    setWaiting(true);
    window.clearTimeout(timeout.current);
    timeout.current = window.setTimeout(() => { setWaiting(false); setError('Goals are unavailable. Update or restart the Argus server.'); }, 4000);
    postMessage({ type: 'getOrchestratorGoals' });
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type !== 'orchestratorGoals' || !Array.isArray(event.data.goals)) return;
      window.clearTimeout(timeout.current);
      setGoals(event.data.goals);
      setWaiting(false);
      setError('');
    };
    window.addEventListener('message', receive);
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { window.removeEventListener('message', receive); window.clearInterval(timer); window.clearTimeout(timeout.current); };
  }, []);

  return <Modal title="Company goals" ariaLabel="Company goals" onClose={onClose} width={640}
    headerActions={<RefreshButton spinning={waiting} onClick={refresh} label="Refresh goals" title="Refresh goals" />}>
    <div className={styles.body}>
      {error && <p role="alert">{error}</p>}
      {goals === null && !error && <p role="status">Loading goals…</p>}
      {goals?.length === 0 && <p>No company goals yet. Start one with $orchestrate.</p>}
      {goals?.map(goal => <section key={`${goal.company}/${goal.goal}`} className={styles.goal} aria-label={`${goal.company}: ${goal.title}`}>
        <div className={styles.goalHeader}>
          <div><strong>{goal.title}</strong><span className={styles.company}>{goal.company}</span></div>
          <span className={styles.status}>{goal.status}</span>
        </div>
        {goal.workers.length === 0 && <p className={styles.empty}>No sessions assigned yet.</p>}
        {goal.workers.map(worker => <button key={worker.key} type="button" className={styles.worker}
          disabled={!worker.sessionId}
          title={worker.sessionId ? `Open ${worker.title}` : 'Session has not started yet'}
          onClick={() => { if (worker.sessionId) { onOpenSession(worker.workspace, worker.sessionId); onClose(); } }}>
          <span className={styles.workerName}>{worker.title}</span>
          <span className={styles.details}>{[worker.providerId, worker.model].filter(Boolean).join(' · ')}</span>
          <span className={styles.status}>{worker.status}</span>
        </button>)}
      </section>)}
    </div>
  </Modal>;
}
