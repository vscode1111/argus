import { useEffect, useId, useMemo } from 'react';
import type { GraphNode, GraphSnapshot } from '../hooks/useAgentGraph';
import { type AgentLayout, BODY, COORDINATOR, connector, hiddenDescendantCounts } from '../utils/agentLayout';
import { useDiagramNavigation } from '../hooks/useDiagramNavigation';
import styles from './AgentDiagram.module.css';
import { ProviderIcon } from './shared/ProviderIcon';
import { agentStatus, ageText, eventTime, settingsText, statusText, roleText, compactText } from '../utils/agentPresentation';
import { AgentTraffic, exchangeLabel } from './AgentTraffic';

interface Props {
  nodes: GraphNode[]; edges: GraphSnapshot['edges']; rows: GraphNode[]; matches: Set<string>; layout: AgentLayout;
  collapsed: Set<string>; onCollapse(id: string): void; selectedId: string | null; onSelect(id: string): void;
  onEdgeSelect?(id: string): void;
  focusId: string | null;
  reachable: Set<string>; childIds: Map<string, Set<string>>;
  now: number;
}
function Body({ role }: { role: string }) {
  if (role === 'super') return <><ellipse rx={BODY.super.width / 2} ry={BODY.super.height / 2} /><ellipse rx={BODY.super.width / 2 - 7} ry={BODY.super.height / 2 - 7} /></>;
  if (role === 'coordinator') return <polygon points={COORDINATOR.map(p => p.join(',')).join(' ')} />;
  return <rect x={-BODY.worker.width / 2} y={-BODY.worker.height / 2} width={BODY.worker.width} height={BODY.worker.height} rx="5" />;
}
function titleLines(title: string) {
  const words = (title || 'Untitled session').split(/\s+/), lines = [''];
  for (const word of words) {
    const last = lines.length - 1;
    if ((lines[last] + ' ' + word).trim().length > 24 && lines[last]) lines.push(word); else lines[last] = (lines[last] + ' ' + word).trim();
  }
  return lines.slice(0, 2).map((line, i) => line.length > 24 || (i === 1 && lines.length > 2) ? line.slice(0, 23) + '…' : line);
}
export function AgentDiagram({ nodes, edges, rows, matches, layout, collapsed, onCollapse, selectedId, onSelect, onEdgeSelect, focusId, reachable, childIds, now }: Props) {
  const marker = useId().replace(/:/g, ''), description = marker + '-help';
  const hiddenCounts = useMemo(() => hiddenDescendantCounts(nodes, edges, collapsed), [nodes, edges, collapsed]);
  const shown = rows.filter(n => reachable.has(n.id)), ids = new Set(shown.map(n => n.id)), visibleKey = JSON.stringify([...ids]);
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const links = useMemo(() => edges.filter(e => ids.has(e.from) && ids.has(e.to)).map(edge => {
    const from = byId.get(edge.from)!, to = byId.get(edge.to)!;
    const parallel = edge.kind !== 'peer' && edges.some(other => other.id !== edge.id && other.from === edge.from && other.to === edge.to);
    const crossParent = edge.kind !== 'peer' && layout.placements[edge.to].anchor !== edge.from;
    const bend = (crossParent ? 350 : 0) + (parallel ? edge.kind === 'reviews' ? 42 : -42 : 0);
    return { edge, line: connector(layout.placements[edge.from], layout.placements[edge.to], from.role, to.role, bend) };
  }), [edges, byId, layout, visibleKey]);
  const companies = Object.entries(layout.centres).filter(([company]) => shown.some(n => n.company === company));
  const points = useMemo(() => [...shown.map(n => layout.placements[n.id]), ...links.map(l => l.line.control), ...companies.map(([, p]) => ({ x: p.x, y: p.y + 110 }))], [visibleKey, layout, links]);
  const navigation = useDiagramNavigation(points);
  useEffect(() => {
    if (!focusId || !layout.placements[focusId]) return;
    navigation.focus(layout.placements[focusId]);
    navigation.svg.current?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(focusId)}"]`)?.focus();
  }, [focusId, navigation.focus]);
  const focusSelected = () => {
    if (!selectedId || !layout.placements[selectedId]) return;
    navigation.focus(layout.placements[selectedId]);
    navigation.svg.current?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(selectedId)}"]`)?.focus();
  };
  return <section className={styles.diagram} aria-label="Schematic">
    <div className={styles.toolbar}>
      <button type="button" onClick={() => navigation.zoom(1.25)} aria-label="Zoom in">+</button><button type="button" onClick={() => navigation.zoom(0.8)} aria-label="Zoom out">−</button>
      <button type="button" onClick={navigation.fit}>Fit all</button><button type="button" onClick={focusSelected} disabled={!selectedId || !ids.has(selectedId)}>Focus selected</button>
      <output aria-label="Diagram zoom">{Math.round(navigation.camera.scale * 100)}%</output>
    </div>
    <p id={description} className={styles.help}>Drag to pan. Pinch or scroll to zoom. With the diagram focused, use arrow keys to pan, + or − to zoom, and 0 to fit.</p>
    <p role="status">{shown.filter(n => matches.has(n.id)).length} matching · {shown.filter(n => !matches.has(n.id)).length} ancestor context · {shown.length} in diagram · {rows.length - shown.length} hidden by collapse</p>
    <svg ref={navigation.svg} className={styles.canvas} role="application" aria-label="Agent diagram" aria-describedby={description} tabIndex={0} {...navigation.events}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrow} /></marker><clipPath id={`${marker}-content`}><rect x="-82" y="-50" width="164" height="100" /></clipPath></defs>
      <g data-diagram-world="" transform={`translate(${navigation.camera.x} ${navigation.camera.y}) scale(${navigation.camera.scale})`}>
        {companies.map(([company, p]) => <text key={company} textAnchor="middle" className={styles.company}><title>{company}</title>{titleLines(company).map((line, i) => <tspan key={i} x={p.x} y={p.y + 110 + i * 18}>{line}</tspan>)}</text>)}
        {links.map(({ edge: e, line }) => {
          const from=byId.get(e.from)!.title,to=byId.get(e.to)!.title;
          return <g key={e.id}><path d={line.path} role="button" tabIndex={0} aria-label={`Inspect diagram link ${from} to ${to} (${e.kind})`} onClick={()=>{if(!navigation.dragged.current)onEdgeSelect?.(e.id);}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();onEdgeSelect?.(e.id);}}} data-edge-id={e.id} data-edge-length={line.length} className={e.kind === 'peer' ? styles.peer : e.kind === 'reviews' ? styles.review : styles.edge} markerEnd={e.kind === 'peer' ? undefined : `url(#${marker})`}><title>{from} {e.kind === 'peer' ? 'peers with' : e.kind} {to}. {exchangeLabel(e,'forward',from,to,now)}. {exchangeLabel(e,'reverse',from,to,now)}</title></path><AgentTraffic edge={e} line={line} from={from} to={to} now={now}/></g>;
        })}
        {shown.map(n => {
          const p = layout.placements[n.id], title = n.title || 'Untitled session';
          return <g key={n.id} data-node-id={n.id} data-status={n.status ?? 'unknown'} transform={`translate(${p.x} ${p.y})`} className={`${styles.node} ${styles[n.status ?? 'unknown'] ?? ''} ${selectedId === n.id ? styles.selected : ''}`} role="button" tabIndex={0} aria-pressed={selectedId === n.id} aria-label={`Inspect ${title}, ${n.role}, ${agentStatus(n)}, ${n.company}, ${n.providerId}, ${settingsText(n)}, Last event: ${ageText(n.lastEventAt,now)}${matches.has(n.id) ? '' : ', ancestor context'}`}
            onClick={() => { if (!navigation.dragged.current) onSelect(n.id); }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n.id); } }}>
            <title>{title} · {n.role} · {agentStatus(n)} · {n.company} · {n.providerId} · {settingsText(n)} · Last event: {eventTime(n.lastEventAt,now)}</title><Body role={n.role} /><foreignObject x='-81' y='-48' width='14' height='14'><ProviderIcon providerId={n.providerId} size={12}/></foreignObject>{n.role === 'coordinator' && collapsed.has(n.id) && <g role="img" aria-label={`${hiddenCounts.get(n.id) ?? 0} hidden ${(hiddenCounts.get(n.id) ?? 0) === 1 ? 'descendant' : 'descendants'} of ${title}`}><circle cx="92" cy="-53" r="18" fill="var(--bg)" stroke="var(--fg)" strokeWidth="2" /><text x="92" y="-48" textAnchor="middle" aria-hidden="true">{hiddenCounts.get(n.id) ?? 0}</text></g>}<text aria-hidden="true" textAnchor="middle" clipPath={`url(#${marker}-content)`}>
              <tspan x="0" y="-36" className={styles.role}>{roleText(n.role)}</tspan>
              {titleLines(title).map((line, i) => <tspan key={i} x="0" y={i * 14 - 20}>{line}</tspan>)}
              <tspan x="0" y="10">{statusText(n)}{matches.has(n.id) ? '' : ' · Context'}</tspan>
              <tspan className={styles.meta} x="0" y="26">{(n.providerId || 'Provider unknown')} · {compactText((n.activeSelection??n.selected)?.model || 'Model unknown')}</tspan>
              <tspan className={styles.meta} x="0" y="42">{compactText((n.activeSelection??n.selected)?.effort || 'Effort unknown',16)} · {ageText(n.lastEventAt,now)}</tspan>
            </text>
          </g>;
        })}
      </g>
    </svg>
    <div className={styles.legend} aria-label="Diagram legend"><span>◎ Super: double oval</span><span>⬡ Coordinator: hexagon</span><span>▣ Work / ✓ Review: rectangle</span><span>Solid → delegates</span><span>Dashed → reviews</span><span>Dotted: peer, no hierarchy</span></div>
    <p className={styles.legend}>● Running (pulse) · ? Needs input · ! Error · ■ Stopped · ○ Idle · ◇ Unknown / Other. <span className={styles.forward}>Forward → child</span><span className={styles.reverse}>Reverse → parent</span> Arrows also encode direction. Recent traffic fades over 12s; ? Parent / ? Child marks who owes reply until resolved (Source / Target for peers). Reduced motion uses static marks.</p>
    <section className={styles.exchanges} aria-label="Latest exchanges">{links.filter(({edge})=>edge.forward||edge.reverse).map(({edge})=><details key={edge.id}><summary>{byId.get(edge.from)!.title} → {byId.get(edge.to)!.title} · {edge.kind}{edge.forward?.awaitingReply?' · Forward reply pending':''}{edge.reverse?.awaitingReply?' · Reverse reply pending':''}</summary>{(['forward','reverse'] as const).map(direction=><p key={direction}>{exchangeLabel(edge,direction,byId.get(edge.from)!.title,byId.get(edge.to)!.title,now)}</p>)}</details>)}</section>
    <div className={styles.collapse} aria-label="Branch controls">{shown.filter(n => childIds.get(n.id)?.size).map(n => <button key={n.id} type="button" aria-expanded={!collapsed.has(n.id)} onClick={() => onCollapse(n.id)}>{collapsed.has(n.id) ? 'Expand' : 'Collapse'} {n.title || 'Untitled session'}</button>)}</div>
  </section>;
}
