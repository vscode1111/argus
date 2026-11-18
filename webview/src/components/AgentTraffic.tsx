import { useId } from 'react';
import type { GraphSnapshot } from '../hooks/useAgentGraph';
import { connector, type Point } from '../utils/agentLayout';
import { exchangeState, eventTime } from '../utils/agentPresentation';
import styles from './AgentDiagram.module.css';
type Edge = GraphSnapshot['edges'][number];
export function exchangeLabel(edge: Edge, direction: 'forward' | 'reverse', from: string, to: string, now: number) {
  const {exchange,waiting}=exchangeState(edge,direction,now),reverse=direction==='reverse';
  return `${reverse?'Reverse':'Forward'}: ${reverse?to:from} → ${reverse?from:to}. ${exchange?.summary || 'No exchange'}. ${exchange ? eventTime(exchange.time,now) : 'Time unknown'}. ${waiting ? `${edge.kind==='peer'?'Recipient':reverse?'Parent':'Child'} owes reply: ${reverse?from:to}` : 'No reply pending'}`;
}
export function AgentTraffic({edge,line,from,to,now}:{edge:Edge;line:ReturnType<typeof connector>;from:string;to:string;now:number}) {
  const id=useId().replace(/:/g,'');
  // Exact subcurves keep both directions on exposed portions of the real edge.
  const point=(t:number):Point=>({x:(1-t)**2*line.a.x+2*(1-t)*t*line.control.x+t*t*line.b.x,y:(1-t)**2*line.a.y+2*(1-t)*t*line.control.y+t*t*line.b.y});
  return <>{(['forward','reverse'] as const).map(direction=>{
    const state=exchangeState(edge,direction,now);if(!state.recent&&!state.waiting)return null;
    const t=direction==='forward'?.14:.86,end=direction==='forward'?.42:.58,a=point(t),b=point(end),control={x:a.x+(end-t)*((1-t)*(line.control.x-line.a.x)+t*(line.b.x-line.control.x)),y:a.y+(end-t)*((1-t)*(line.control.y-line.a.y)+t*(line.b.y-line.control.y))};
    const marker=`${id}-${direction}`;
    const path=`M${a.x} ${a.y}Q${control.x} ${control.y} ${b.x} ${b.y}`,label=exchangeLabel(edge,direction,from,to,now);
    return <g key={direction} className={direction==='forward'?styles.forward:styles.reverse}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor" /></marker></defs>
      {state.recent && state.waiting && <path data-wait-mark={`${edge.id}-${direction}`} d={path} className={styles.traffic} style={{strokeWidth:2,strokeDasharray:'none'}} markerEnd={`url(#${marker})`} aria-hidden="true"/>}
      <path data-traffic={`${edge.id}-${direction}`} data-recent={state.recent} data-waiting={state.waiting} d={path} className={`${styles.traffic} ${state.recent?styles.flow:''}`} style={{opacity:state.recent?state.opacity:1}} markerEnd={`url(#${marker})`} role="img" aria-label={label}><title>{label}</title></path>
      {state.waiting && <text x={point((t+end)/2).x+12} y={point((t+end)/2).y+4} className={styles.waitLabel} aria-hidden="true">? {edge.kind==='peer'?(direction==='reverse'?'Source':'Target'):(direction==='reverse'?'Parent':'Child')}</text>}
    </g>;
  })}</>;
}
