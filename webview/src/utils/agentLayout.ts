import type { GraphNode, GraphSnapshot } from '../hooks/useAgentGraph';

type Node = Pick<GraphNode, 'id' | 'company' | 'role' | 'title'>;
type Edge = Pick<GraphSnapshot['edges'][number], 'from' | 'to' | 'kind'>;
export interface Point { x: number; y: number }
export interface Slot extends Point { company: string; region: string; slotClass: string; anchor: string | null; depth: number; occupant: string | null }
export interface AgentLayout { slots: Slot[]; placements: Record<string, Slot>; centres: Record<string, Point> }
export const BODY = { super: { width: 232, height: 152 }, coordinator: { width: 220, height: 120 }, worker: { width: 180, height: 104 } };
export const COORDINATOR = [[-110, 0], [-85, -60], [85, -60], [110, 0], [85, 60], [-85, 60]];
const BRANCH_GAP = 250, CLEAR_X = 272, CLEAR_Y = 194;
const roleOrder = ['super', 'coordinator', 'work', 'review'];
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const roleRank = (role: string) => roleOrder.includes(role) ? roleOrder.indexOf(role) : roleOrder.length;
const compare = (a: Node, b: Node) => roleRank(a.role) - roleRank(b.role) || compareText(a.title, b.title) || compareText(a.id, b.id);

// The anchor is a display choice only. No actual edge is removed or rewritten.
export function displayHierarchy(nodes: Node[], edges: Edge[]) {
  const sorted = [...nodes].sort(compare), ids = new Set(nodes.map(n => n.id));
  const parents = new Map<string, Set<string>>(), children = new Map<string, Set<string>>();
  for (const e of edges) if (e.kind !== 'peer' && ids.has(e.from) && ids.has(e.to)) {
    if (!parents.has(e.to)) parents.set(e.to, new Set());
    if (!children.has(e.from)) children.set(e.from, new Set());
    parents.get(e.to)!.add(e.from); children.get(e.from)!.add(e.to);
  }
  const depth = new Map<string, number>(), anchor = new Map<string, string | null>();
  const queue = sorted.filter(n => !parents.get(n.id)?.size).map(n => n.id);
  for (const id of queue) { depth.set(id, 0); anchor.set(id, null); }
  const rank = new Map(sorted.map((n, i) => [n.id, i]));
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]) ?? []) {
    const next = depth.get(queue[i])! + 1, prior = depth.get(child);
    if (prior === undefined || next < prior || (next === prior && rank.get(queue[i])! < rank.get(anchor.get(child)!)!)) {
      depth.set(child, next); anchor.set(child, queue[i]); queue.push(child);
    }
  }
  // Defensive orphan fallback; the authoritative graph normally rejects cycles.
  for (const n of sorted) if (!depth.has(n.id)) { depth.set(n.id, 0); anchor.set(n.id, null); }
  return { parents, children, depth, anchor, sorted: sorted.sort((a, b) => depth.get(a.id)! - depth.get(b.id)! || compare(a, b)) };
}

export function layoutGraph(nodes: Node[], edges: Edge[], previous?: AgentLayout): AgentLayout {
  const ids = new Set(nodes.map(n => n.id));
  if (previous && Object.keys(previous.placements).length === ids.size && Object.keys(previous.placements).every(id => ids.has(id))) return previous;
  const hierarchy = displayHierarchy(nodes, edges);
  const slots = (previous?.slots ?? []).map(s => s.occupant && !ids.has(s.occupant) ? { ...s, occupant: null } : s);
  const placements: Record<string, Slot> = Object.create(null), centres: Record<string, Point> = Object.assign(Object.create(null), previous?.centres);
  for (const slot of slots) if (slot.occupant) placements[slot.occupant] = slot;
  const ordered = [...hierarchy.sorted].sort((a, b) => hierarchy.depth.get(a.id)! - hierarchy.depth.get(b.id)! || compareText(a.company, b.company) || compare(a, b));
  for (const node of ordered) {
      if (placements[node.id]) continue;
      const company = node.company;
      const parentId = hierarchy.anchor.get(node.id) ?? null, parent = parentId ? placements[parentId] : undefined;
      const region = parent?.region ?? company;
      if (!centres[region]) centres[region] = { x: slots.length ? Math.max(...slots.map(s => s.x)) + 750 : 0, y: 0 };
      const centre = centres[region];
      const rootSupers = ordered.filter(n => n.company === company && n.role === 'super' && !hierarchy.anchor.get(n.id));
      const slotClass = parentId ? 'child' : node.role === 'super' ? rootSupers.length === 1 ? 'central-super' : 'super-root' : 'root-branch';
      const vacant = slots.findIndex(s => !s.occupant && s.company === company && s.region === region && s.anchor === parentId && s.slotClass === slotClass);
      if (vacant >= 0) { slots[vacant] = { ...slots[vacant], occupant: node.id }; placements[node.id] = slots[vacant]; continue; }
      const siblings = ordered.filter(n => hierarchy.anchor.get(n.id) === parentId && (parentId || (n.company === company && (n.role === 'super') === (node.role === 'super')))), index = siblings.findIndex(n => n.id === node.id);
      const origin = parent ?? centre, radial = Math.atan2(origin.y - centre.y, origin.x - centre.x);
      const central = !parent || Math.hypot(parent.x - centre.x, parent.y - centre.y) < 1;
      const fan = index - (siblings.length - 1) / 2;
      const angle = central ? parent ? -Math.PI / 2 + fan * Math.min(1.3, 4 / siblings.length) : -Math.PI / 2 + index * Math.PI * 2 / siblings.length : radial + fan * Math.min(0.45, 1.2 / siblings.length);
      let distance = slotClass === 'central-super' ? 0 : BRANCH_GAP;
      let point: Point;
      do { point = { x: origin.x + Math.cos(angle) * distance, y: origin.y + Math.sin(angle) * distance }; distance += BRANCH_GAP; }
      while (slots.some(s => Math.abs(s.x - point.x) < CLEAR_X && Math.abs(s.y - point.y) < CLEAR_Y));
      const slot = { ...point, company, region, slotClass, anchor: parentId, depth: hierarchy.depth.get(node.id)!, occupant: node.id };
      slots.push(slot); placements[node.id] = slot;
  }
  return { slots, placements, centres };
}

export function expandedNodes(nodes: Node[], edges: Edge[], collapsed: ReadonlySet<string>) {
  const { parents, children } = displayHierarchy(nodes, edges);
  const visible = new Set(nodes.filter(n => !parents.get(n.id)?.size).map(n => n.id)), queue = [...visible];
  for (let i = 0; i < queue.length; i++) if (!collapsed.has(queue[i])) for (const id of children.get(queue[i]) ?? []) {
    if (!visible.has(id)) { visible.add(id); queue.push(id); }
  }
  return visible;
}

export function hiddenDescendantCounts(nodes: Node[], edges: Edge[], collapsed: ReadonlySet<string>) {
  const visible = expandedNodes(nodes, edges, collapsed), { children } = displayHierarchy(nodes, edges), counts = new Map<string, number>();
  for (const root of collapsed) {
    const seen = new Set<string>(), queue = [...(children.get(root) ?? [])];
    for (let id = queue.pop(); id; id = queue.pop()) if (id !== root && !seen.has(id)) { seen.add(id); queue.push(...(children.get(id) ?? [])); }
    counts.set(root, [...seen].filter(id => !visible.has(id)).length);
  }
  return counts;
}

// Intersect a ray with the same ellipse/polygon/rectangle used by the SVG body.
export function bodyBoundary(role: string, toward: Point): Point {
  const length = Math.hypot(toward.x, toward.y), ux = toward.x / length, uy = toward.y / length;
  let distance: number;
  if (role === 'super') distance = 1 / Math.hypot(ux / (BODY.super.width / 2), uy / (BODY.super.height / 2));
  else if (role !== 'coordinator') distance = Math.min((BODY.worker.width / 2) / Math.abs(ux), (BODY.worker.height / 2) / Math.abs(uy));
  else {
    distance = Infinity;
    for (let i = 0; i < COORDINATOR.length; i++) {
      const [ax, ay] = COORDINATOR[i], [bx, by] = COORDINATOR[(i + 1) % COORDINATOR.length], vx = bx - ax, vy = by - ay;
      const cross = ux * vy - uy * vx;
      if (Math.abs(cross) < 1e-9) continue;
      const ray = (ax * vy - ay * vx) / cross, side = (ax * uy - ay * ux) / cross;
      if (ray >= 0 && side >= 0 && side <= 1) distance = Math.min(distance, ray);
    }
  }
  return { x: ux * distance, y: uy * distance };
}
export function connector(from: Point, to: Point, fromRole: string, toRole: string, bend = 0) {
  const delta = { x: to.x - from.x, y: to.y - from.y }, length = Math.hypot(delta.x, delta.y);
  const ux = delta.x / length, uy = delta.y / length;
  const control = { x: (from.x + to.x) / 2 - uy * bend, y: (from.y + to.y) / 2 + ux * bend };
  const startRay = { x: control.x - from.x, y: control.y - from.y }, endRay = { x: control.x - to.x, y: control.y - to.y };
  const start = bodyBoundary(fromRole, startRay), end = bodyBoundary(toRole, endRay);
  const startLength = Math.hypot(startRay.x, startRay.y), endLength = Math.hypot(endRay.x, endRay.y);
  const a = { x: from.x + start.x + startRay.x / startLength * 4, y: from.y + start.y + startRay.y / startLength * 4 };
  const b = { x: to.x + end.x + endRay.x / endLength * 10, y: to.y + end.y + endRay.y / endLength * 10 };
  return { a, b, control, length: (b.x - a.x) * ux + (b.y - a.y) * uy, path: `M ${a.x} ${a.y} ${bend ? `Q ${control.x} ${control.y} ${b.x} ${b.y}` : `L ${b.x} ${b.y}`}` };
}
