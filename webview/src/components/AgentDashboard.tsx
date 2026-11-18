import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphView } from '../hooks/useAgentGraph';
import { AgentNodeDetail } from './AgentNodeDetail';
import { AgentEdgeDetail } from './AgentEdgeDetail';
import styles from './AgentDashboard.module.css';
import { AgentDiagram } from './AgentDiagram';
import { layoutGraph, expandedNodes, type AgentLayout } from '../utils/agentLayout';
import { ageText, eventTime, settingsText, statusText } from '../utils/agentPresentation';

interface Props { graph: GraphView; onBack(): void; onGoals(): void; onOpenSession(workspace: string, id: string): void }
export function AgentDashboard({ graph, onBack, onGoals, onOpenSession }: Props) {
  const [, setTick] = useState(0), now = Date.now();
  useEffect(() => { const timer = window.setInterval(() => setTick(tick => tick + 1), 1000); return () => window.clearInterval(timer); }, []);
  const [company, setCompany] = useState(''), [goal, setGoal] = useState(''), [status, setStatus] = useState(''), [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edgeId,setEdgeId]=useState<string|null>(null);
  useEffect(()=>{if(selectedId)setEdgeId(null);},[selectedId]);
  const [mode, setMode] = useState<'table' | 'diagram'>('table'), [collapsed, setCollapsed] = useState(new Set<string>());
  const [focusId, setFocusId] = useState<string | null>(null);
  const layoutMemory = useRef<AgentLayout>();
  const { snapshot, loading, error } = graph;
  const layout = useMemo(() => snapshot ? layoutGraph(snapshot.nodes, snapshot.edges, layoutMemory.current) : layoutMemory.current, [snapshot]);
  useLayoutEffect(() => { layoutMemory.current = layout; }, [layout]);
  const { nodes, parents, children, byId } = useMemo(() => {
    const nodes = snapshot?.nodes ?? [], parents = new Map<string, Set<string>>(), children = new Map<string, Set<string>>();
    for (const edge of snapshot?.edges ?? []) if (edge.kind !== 'peer') {
      if (!parents.has(edge.to)) parents.set(edge.to, new Set());
      if (!children.has(edge.from)) children.set(edge.from, new Set());
      parents.get(edge.to)!.add(edge.from); children.get(edge.from)!.add(edge.to);
    }
    return { nodes, parents, children, byId: new Map(nodes.map(n => [n.id, n])) };
  }, [snapshot]);
  const view = useMemo(() => {
    const matches = new Set(nodes.filter(n => (!company || n.company === company) && (!goal || n.goal === goal)
      && (!status || (n.status ?? 'unknown') === status) && n.title.toLowerCase().includes(search.trim().toLowerCase())).map(n => n.id));
    const visible = new Set(matches), queue = [...matches];
    for (let id = queue.pop(); id; id = queue.pop()) for (const parent of parents.get(id) ?? []) {
      if (!visible.has(parent)) { visible.add(parent); queue.push(parent); }
    }
    const rows = nodes.filter(n => visible.has(n.id)).sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    return { matches, rows };
  }, [nodes, parents, company, goal, status, search]);
  const reachable = useMemo(() => expandedNodes(nodes, snapshot?.edges ?? [], collapsed), [nodes, snapshot, collapsed]);
  const selected = view.rows.find(n => n.id === selectedId && (mode === 'table' || reachable.has(n.id)));
  const visibleIds=new Set(view.rows.filter(n=>mode==='table'||reachable.has(n.id)).map(n=>n.id));
  const visibleEdges=snapshot?.edges.filter(e=>visibleIds.has(e.from)&&visibleIds.has(e.to))??[];
  const selectedEdge=visibleEdges.find(e=>e.id===edgeId);
  useEffect(()=>{if(edgeId&&!selectedEdge)setEdgeId(null);},[edgeId,selectedEdge]);
  useEffect(() => { if (selectedId && !selected) setSelectedId(null); }, [selectedId, selected]);
  const relationNames = (id: string, incoming: boolean) => [...((incoming ? parents : children).get(id) ?? [])].map(id => byId.get(id)?.title || 'Untitled session').join(', ') || 'None';
  const companies = [...new Set(nodes.map(n => n.company))].sort(), goals = [...new Set(nodes.map(n => n.goal))].sort();
  const clear = () => { setCompany(''); setGoal(''); setStatus(''); setSearch(''); };
  const focusInDiagram = () => {
    if (!selected) return;
    const ancestry = new Set<string>(), queue = [selected.id];
    for (let id = queue.pop(); id; id = queue.pop()) for (const parent of parents.get(id) ?? []) if (!ancestry.has(parent)) { ancestry.add(parent); queue.push(parent); }
    setCollapsed(current => new Set([...current].filter(id => !ancestry.has(id))));
    setFocusId(selected.id); setMode('diagram');
  };
  return <main className={styles.dashboard} aria-label="Agent dashboard">
    <header className={styles.header}><h1>Agent dashboard</h1><div className={styles.actions}>
      <button type="button" onClick={onGoals}>Company goals</button><button type="button" onClick={onBack}>Back to conversation</button>
    </div></header>
    <div className={styles.filters}>
      <label>Company<select value={company} onChange={e => setCompany(e.target.value)}><option value="">All companies</option>{companies.map(c => <option key={c}>{c}</option>)}</select></label>
      <label>Goal<select value={goal} onChange={e => setGoal(e.target.value)}><option value="">All goals</option>{goals.map(g => <option key={g}>{g}</option>)}</select></label>
      <label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{['running', 'needs-input', 'idle', 'error', 'stopped', 'unknown'].map(s => <option key={s} value={s}>{s === 'unknown' ? 'Unknown' : s === 'needs-input' ? 'Needs input' : s[0].toUpperCase() + s.slice(1)}</option>)}</select></label>
      <label>Search title<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
    </div>
    {loading && <p role="status">Loading agents…</p>}
    {!snapshot && !loading && !error && <p role="status">Waiting for connection…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={graph.refresh} aria-label="Retry agents">Retry</button></div>}
    {snapshot && <>
      <div className={styles.actions} role="group" aria-label="Dashboard view"><button type="button" aria-pressed={mode === 'table'} onClick={() => setMode('table')}>Table</button><button type="button" aria-pressed={mode === 'diagram'} onClick={() => { setFocusId(null); setMode('diagram'); }}>Diagram</button></div>
      <p className={styles.counts} role="status">{view.matches.size} {view.matches.size === 1 ? 'match' : 'matches'} · {view.rows.length - view.matches.size} context · {view.rows.length} {mode === 'table' ? 'visible' : 'in filtered table'} / {nodes.length} total<br />
        <strong className={styles.needsInput} role="status" aria-label="Needs input summary">? {nodes.filter(n => view.matches.has(n.id) && n.status === 'needs-input').length} matching needs input / {nodes.filter(n => n.status === 'needs-input').length} total</strong></p>
      {!nodes.length ? <p>No agents yet.</p> : !view.matches.size ? <div><p>No matching agents.</p><button type="button" onClick={clear}>Clear filters</button></div> : mode === 'diagram' && layout ? <AgentDiagram nodes={nodes} edges={snapshot.edges} rows={view.rows} matches={view.matches} layout={layout} collapsed={collapsed} selectedId={selectedId} onSelect={setSelectedId} onEdgeSelect={id=>{setSelectedId(null);setEdgeId(id);}} focusId={focusId} reachable={reachable} childIds={children} now={now} onCollapse={id => setCollapsed(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} /> : <table className={styles.table}>
        <caption>Agent sessions</caption><thead><tr><th scope="col">Session</th><th scope="col">Status and provider</th><th scope="col">Scope and parents</th><th scope="col">Actions</th></tr></thead>
        <tbody>{view.rows.map(n => <tr key={n.id}>
          <td data-label="Session"><strong>{n.title || 'Untitled session'}</strong><span>{n.role}</span>{!view.matches.has(n.id) && <span className={styles.context}>Ancestor context</span>}</td>
          <td data-label="Status and provider">{statusText(n)}<span>{n.providerId} · {settingsText(n)}</span><span title={eventTime(n.lastEventAt,now)}>Last event: {ageText(n.lastEventAt,now)}</span></td>
          <td data-label="Scope and parents">{n.company} · {n.goal}<span>Parents: {relationNames(n.id, true)}</span></td>
          <td data-label="Actions"><div className={styles.actions}><button type="button" aria-label={`Inspect ${n.title || 'Untitled session'}`} aria-pressed={selectedId === n.id} onClick={() => setSelectedId(n.id)}>Inspect</button><button type="button" aria-label={`Open ${n.title || 'Untitled session'}`} onClick={() => onOpenSession(n.workspace, n.id)}>Open session</button></div></td>
        </tr>)}</tbody>
      </table>}
      <section aria-label="Agent links"><h2>Links</h2>{visibleEdges.map(edge=><p key={edge.id}><button type="button" aria-pressed={edgeId===edge.id} aria-label={`Inspect link ${byId.get(edge.from)?.title} to ${byId.get(edge.to)?.title} (${edge.kind})`} onClick={()=>{setEdgeId(edge.id);setSelectedId(null);}}>{byId.get(edge.from)?.title} → {byId.get(edge.to)?.title} · {edge.kind}</button></p>)}</section>
      {selected && <AgentNodeDetail key={`${snapshot.revision.epoch}:${selected.id}:${selected.workspace}:${selected.providerId}`} node={selected} parents={[...parents.get(selected.id)??[]].flatMap(id=>byId.has(id)?[byId.get(id)!]:[])} children={[...children.get(selected.id)??[]].flatMap(id=>byId.has(id)?[byId.get(id)!]:[])} onFocus={mode==='table'?focusInDiagram:undefined} onOpen={()=>onOpenSession(selected.workspace,selected.id)} onClose={()=>setSelectedId(null)}/>}
      {selectedEdge&&<AgentEdgeDetail edge={selectedEdge} from={byId.get(selectedEdge.from)!} to={byId.get(selectedEdge.to)!} now={now} onClose={()=>setEdgeId(null)}/>}
    </>}
  </main>;
}
