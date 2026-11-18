import type {GraphSnapshot,GraphNode} from '../hooks/useAgentGraph';
import {exchangeLabel} from './AgentTraffic';
import styles from './AgentDashboard.module.css';
interface Props {edge:GraphSnapshot['edges'][number];from:GraphNode;to:GraphNode;now:number;onClose():void}
export function AgentEdgeDetail({edge,from,to,now,onClose}:Props){
  const push=edge.push;
  return <section className={styles.details} aria-label="Link details"><h2>{from.title || 'Untitled session'} → {to.title || 'Untitled session'}</h2><p>{edge.kind}</p><p>From: {from.id}</p><p>To: {to.id}</p>{(['forward','reverse'] as const).map(d=><p key={d}>{exchangeLabel(edge,d,from.title,to.title,now)}</p>)}
    <h3>Push settings (read only)</h3><p>Questions: {(push?.questions??true)?'On':'Off'} · Errors: {(push?.errors??true)?'On':'Off'} · Turn end: {(push?.turnEnd??true)?'On':'Off'} · Tool failures: {push?.milestones?.includes('tool-failure')?'On':'Off'}</p><button type="button" onClick={onClose}>Close link details</button>
  </section>;
}
