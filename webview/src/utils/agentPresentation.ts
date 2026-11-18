import type { GraphNode, GraphSnapshot } from '../hooks/useAgentGraph';
import { agentStatus } from '../components/AgentConnections';
export const RECENT_MS = 12000;
export const compactText = (text: string, limit = 18) => text.length > limit ? text.slice(0, limit - 1) + '…' : text;
export function ageText(time: number | null | undefined, now: number) {
  if (time == null || !Number.isFinite(time) || time > now) return 'Unknown';
  const seconds = Math.floor((now - time) / 1000);
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
}
export function eventTime(time: number | null | undefined, now: number) {
  return time == null || !Number.isFinite(time) || !Number.isFinite(new Date(time).getTime()) ? 'Unknown' : `${new Date(time).toISOString()} (${ageText(time, now)})`;
}
export function settingsText(node: GraphNode) {
  const selection = node.activeSelection ?? node.selected;
  return `${selection?.model || 'Model unknown'} · ${selection?.effort || 'Effort unknown'}`;
}
export function statusText(node: GraphNode) {
  const symbol = { running: '●', 'needs-input': '?', error: '!', stopped: '■', idle: '○' }[node.status ?? 'idle'];
  return `${node.status ? symbol : '◇'} ${agentStatus(node)}`;
}
export function roleText(role: GraphNode['role']) { return ({super:'◎ Super',coordinator:'⬡ Coordinator',review:'✓ Review',work:'▣ Work',other:'◇ Other'})[role]; }
export function exchangeState(edge: GraphSnapshot['edges'][number], direction: 'forward' | 'reverse', now: number) {
  const exchange = edge[direction];
  const elapsed = exchange && Number.isFinite(exchange.time) && exchange.time <= now ? now - exchange.time : Infinity;
  return { exchange, recent: elapsed >= 0 && elapsed < RECENT_MS, waiting: exchange?.awaitingReply === true, opacity: Math.max(0, 1 - elapsed / RECENT_MS) };
}
