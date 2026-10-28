/**
 * The fold tree (from wren's metro map, designs/2026-10-23-metro-fold-tree.md). A node holds
 * marks and nodes, to any depth. The viewer's fold is a depth cut and hand changes on top: a node is open when its depth is
 * under the cut, unless the viewer opened or closed it by hand.
 */

export interface FoldNode {
  id: string;
  /** The node it sits in. None: the map itself. */
  parent?: string | undefined;
  /** The name in the breadcrumb. */
  label: string;
  /** Opens by hand only: the depth cut never opens it. */
  hand?: boolean | undefined;
}

/** Nodes opened (true) or closed (false) by hand, over the depth cut. */
export type OpenMap = Readonly<Record<string, boolean>>;

/** What the viewer folded: the depth cut and the hand changes. */
export interface Fold {
  depth: number;
  open: OpenMap;
}

/** How deep each node sits: 0 for a node in the map itself. */
export function depthsOf(nodes: readonly FoldNode[]): Map<string, number> {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, number>();
  const at = (id: string, seen: number): number => {
    const known = out.get(id);
    if (known !== undefined) return known;
    const p = by.get(id)?.parent;
    // A parent that is not a node, or a loop, ends the walk.
    const d = p && by.has(p) && seen < by.size ? at(p, seen + 1) + 1 : 0;
    out.set(id, d);
    return d;
  };
  for (const n of nodes) at(n.id, 0);
  return out;
}

/** The cut that opens every node. 0 when there is none. */
export function fullDepth(nodes: readonly FoldNode[]): number {
  const depth = depthsOf(nodes);
  const cut = nodes.filter((n) => !n.hand).map((n) => (depth.get(n.id) ?? 0) + 1);
  return cut.length ? Math.max(...cut) : 0;
}

/** The node and the nodes it sits in, outermost first. */
export function pathTo(nodes: readonly FoldNode[], id: string): FoldNode[] {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const out: FoldNode[] = [];
  for (let n = by.get(id); n && out.length <= by.size; n = n.parent ? by.get(n.parent) : undefined)
    out.unshift(n);
  return out;
}

/**
 * The nodes that show open: open by the cut or by hand, inside nodes that show open too. A node
 * inside a closed one never counts, so two folds that draw the same map give the same set.
 */
export function openSet(nodes: readonly FoldNode[], fold: Fold): Set<string> {
  const depth = depthsOf(nodes);
  const own = (n: FoldNode) => fold.open[n.id] ?? (!n.hand && (depth.get(n.id) ?? 0) < fold.depth);
  const out = new Set<string>();
  // Outermost first, so a parent is decided before its children.
  for (const n of [...nodes].sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0)))
    if (own(n) && (!n.parent || out.has(n.parent) || !depth.has(n.parent))) out.add(n.id);
  return out;
}

/** A stable key for an open set. */
export const openKey = (open: ReadonlySet<string>): string => [...open].sort().join("|");

/** Open or close one node by hand. Opening opens the nodes it sits in too. */
export function toggle(nodes: readonly FoldNode[], fold: Fold, id: string, on: boolean): Fold {
  const now = openSet(nodes, fold);
  const depth = depthsOf(nodes);
  const next: Record<string, boolean> = { ...fold.open };
  const by = new Map(nodes.map((n) => [n.id, n]));
  const set = (k: string, v: boolean) => {
    // A change that equals the cut is no change.
    if (v === (!by.get(k)?.hand && (depth.get(k) ?? 0) < fold.depth)) delete next[k];
    else next[k] = v;
  };
  if (on) for (const n of pathTo(nodes, id)) if (!now.has(n.id)) set(n.id, true);
  if (!on) set(id, false);
  return { depth: fold.depth, open: next };
}

/** Open the path to a node and close the rest. */
export function reveal(nodes: readonly FoldNode[], id: string | undefined): Fold {
  return {
    depth: 0,
    open: Object.fromEntries((id ? pathTo(nodes, id) : []).map((n) => [n.id, true])),
  };
}

/** Step the cut by `d` (pinch in: +1, out: -1). Hand changes clear. */
export function stepDepth(nodes: readonly FoldNode[], depth: number, d: number): Fold {
  const full = fullDepth(nodes);
  return { depth: Math.max(0, Math.min(full, Math.min(depth, full) + d)), open: {} };
}

/** Every node open, the ones that open by hand too: what a focus shows. */
export const allOpen = (nodes: readonly FoldNode[]): Set<string> => new Set(nodes.map((n) => n.id));
