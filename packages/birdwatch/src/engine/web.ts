/**
 * The research web (wren designs/2026-11-05-research-web.md): every run as an island, a radial tree
 * run → query → site or channel → page → finding; a site or channel two runs used is a hub between
 * them. Positions are a pure function of the records: the same ledger draws the same web.
 */
import { kept as keptOf, queriesOf, type RunState } from "./state.js";

export type WebKind = "run" | "query" | "source" | "hub" | "page" | "finding";

export interface WebNode {
  id: string;
  kind: WebKind;
  label: string;
  x: number;
  y: number;
  size: number;
  /** The run it belongs to; none on a hub. */
  run?: string;
  /** The ledger folder (a day's study). */
  group?: string;
  url?: string;
  /** A page read whole; a listed-only page is faint. */
  read?: boolean;
  /** A finding the run kept. */
  kept?: boolean;
  /** The run's ask kind (web, video, channel...): its colour. */
  ask?: string;
  /** How many runs a hub joins. */
  runs?: number;
  /** A source's site or channel ("site:x.com", "channel:Name"): what a hub joins on. */
  key?: string;
}

export interface WebEdge {
  source: string;
  target: string;
  kind: "tree" | "hub";
}

export interface ResearchWeb {
  v: 1;
  nodes: WebNode[];
  edges: WebEdge[];
}

/** Each kind's ring, before an island grows to fit its leaves: a folded page keeps the page ring. */
const RING: Record<Exclude<WebKind, "hub">, number> = {
  run: 0,
  query: 90,
  source: 190,
  page: 300,
  finding: 380,
};
/** The least arc between two leaves on the outer ring. */
const LEAF_ARC = 9;
const GAP = 160;
/** Islands per row before a group wraps. */
const ROW = 6;
const SIZE: Record<WebKind, number> = {
  run: 14,
  hub: 8,
  query: 5,
  source: 4,
  page: 2.5,
  finding: 1.5,
};

interface TreeNode {
  node: Omit<WebNode, "x" | "y">;
  children: TreeNode[];
  leaves: number;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A page's place: its channel when the listing names one, else its site. */
const sourceKey = (h: { url: string; channel?: string | undefined }) =>
  h.channel ? `channel:${h.channel}` : `site:${hostOf(h.url)}`;

const sourceLabel = (key: string) => key.slice(key.indexOf(":") + 1);

function islandOf(state: RunState, group: string): TreeNode {
  const run = state.run;
  const base = { run, group };
  const qOf = queriesOf(state);
  const docOf = new Map(state.documents.map((d) => [d.hit, d]));
  const findingsOf = new Map<string, typeof state.findings>();
  for (const f of state.findings) {
    const list = findingsOf.get(f.document) ?? [];
    list.push(f);
    findingsOf.set(f.document, list);
  }
  const queryIds = new Set(state.queries.map((q) => q.id));
  const named = "named";
  // a page hangs under the first query that found it; pages the agent named sit under one node
  const byQuery = new Map<string, Map<string, typeof state.hits>>();
  for (const h of state.hits) {
    const q = [...(qOf.get(h.id) ?? [])].find((x) => queryIds.has(x)) ?? named;
    const bySource = byQuery.get(q) ?? new Map<string, typeof state.hits>();
    const k = sourceKey(h);
    const list = bySource.get(k) ?? [];
    list.push(h);
    bySource.set(k, list);
    byQuery.set(q, bySource);
  }
  const tree = (node: TreeNode["node"], children: TreeNode[]): TreeNode => ({
    node,
    children,
    leaves: children.length ? children.reduce((a, c) => a + c.leaves, 0) : 1,
  });
  const pageOf = (h: (typeof state.hits)[number], key?: string): TreeNode => {
    const doc = docOf.get(h.id);
    return tree(
      {
        id: h.id,
        kind: "page",
        label: doc?.title ?? h.title ?? h.url,
        size: SIZE.page,
        url: h.url,
        read: Boolean(doc),
        ...(key ? { key } : {}),
        ...base,
      },
      (doc ? (findingsOf.get(doc.id) ?? []) : []).map((f) =>
        tree(
          {
            id: f.id,
            kind: "finding",
            label: f.text,
            size: SIZE.finding,
            kept: keptOf(state, f),
            ...base,
          },
          [],
        ),
      ),
    );
  };
  const queries = [
    ...state.queries.map((q) => ({ id: q.id, label: q.terms, url: q.follow?.url })),
    ...(byQuery.has(named) ? [{ id: named, label: "pages named by hand", url: undefined }] : []),
  ];
  return tree(
    {
      id: run,
      kind: "run",
      label: state.snapshot?.ask.text ?? run,
      size: SIZE.run,
      ...base,
      ...(state.snapshot ? { ask: state.snapshot.ask.kind } : {}),
    },
    queries.map((q) =>
      tree(
        {
          id: `${run}/q/${q.id}`,
          kind: "query",
          label: q.label,
          size: SIZE.query,
          ...base,
          ...(q.url ? { url: q.url } : {}),
        },
        [...(byQuery.get(q.id) ?? new Map<string, typeof state.hits>()).entries()].map(
          ([k, hits]) => {
            const [only] = hits;
            // a site with one page folds into the page: it keeps the key for hubs
            if (only && hits.length === 1) return pageOf(only, k);
            return tree(
              {
                id: `${run}/q/${q.id}/${k}`,
                kind: "source",
                label: sourceLabel(k),
                size: SIZE.source,
                key: k,
                ...base,
              },
              hits.map((h) => pageOf(h)),
            );
          },
        ),
      ),
    ),
  );
}

/** The island's radius: its outer ring, grown so leaves keep LEAF_ARC apart. */
const radiusOf = (t: TreeNode) => Math.max(RING.finding, (t.leaves * LEAF_ARC) / (2 * Math.PI));

/** Places a tree around (cx, cy): each child gets an arc share by its leaves. */
function place(
  t: TreeNode,
  cx: number,
  cy: number,
  scale: number,
  out: { nodes: WebNode[]; edges: WebEdge[] },
) {
  const walk = (n: TreeNode, from: number, to: number, parent: string | null) => {
    const mid = (from + to) / 2;
    const r = RING[n.node.kind as keyof typeof RING] * scale;
    out.nodes.push({ ...n.node, x: cx + r * Math.cos(mid), y: cy + r * Math.sin(mid) });
    if (parent) out.edges.push({ source: parent, target: n.node.id, kind: "tree" });
    let at = from;
    for (const c of n.children) {
      const span = ((to - from) * c.leaves) / n.leaves;
      walk(c, at, at + span, n.node.id);
      at += span;
    }
  };
  walk(t, 0, 2 * Math.PI, null);
}

/**
 * The web of every run given: islands in rows by group (ledger folder, sorted), runs in start
 * order, ROW per row; hubs at the middle of the runs they join. A new run in the last group moves
 * no older node.
 */
export function webOf(runs: readonly { group: string; state: RunState }[]): ResearchWeb {
  const out: { nodes: WebNode[]; edges: WebEdge[] } = { nodes: [], edges: [] };
  const started = (s: RunState) => s.records[0]?.at ?? "";
  const ordered = [...runs].sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      started(a.state).localeCompare(started(b.state)) ||
      a.state.run.localeCompare(b.state.run),
  );
  const centre = new Map<string, { x: number; y: number }>();
  let top = 0;
  let row: { tree: TreeNode; r: number; run: string }[] = [];
  const flush = () => {
    if (!row.length) return;
    const h = Math.max(...row.map((x) => x.r));
    let left = 0;
    // top-aligned: a bigger island later in the row moves no earlier one
    for (const { tree, r, run } of row) {
      const cx = left + r;
      const cy = top + r;
      place(tree, cx, cy, r / RING.finding, out);
      centre.set(run, { x: cx, y: cy });
      left += 2 * r + GAP;
    }
    top += 2 * h + GAP;
    row = [];
  };
  let group: string | null = null;
  for (const { group: g, state } of ordered) {
    if (g !== group || row.length === ROW) flush();
    group = g;
    const tree = islandOf(state, g);
    row.push({ tree, r: radiusOf(tree), run: state.run });
  }
  flush();
  // hubs: a site or channel two or more runs listed
  const usedBy = new Map<string, Map<string, string[]>>();
  for (const n of out.nodes) {
    if (!n.run || !n.key) continue;
    const key = n.key;
    const byRun = usedBy.get(key) ?? new Map<string, string[]>();
    const ids = byRun.get(n.run) ?? [];
    ids.push(n.id);
    byRun.set(n.run, ids);
    usedBy.set(key, byRun);
  }
  for (const [key, byRun] of [...usedBy].sort(([a], [b]) => a.localeCompare(b))) {
    if (byRun.size < 2) continue;
    const at = [...byRun.keys()].map((r) => centre.get(r) as { x: number; y: number });
    const id = `hub:${key}`;
    out.nodes.push({
      id,
      kind: "hub",
      label: sourceLabel(key),
      x: at.reduce((a, p) => a + p.x, 0) / at.length,
      y: at.reduce((a, p) => a + p.y, 0) / at.length,
      size: SIZE.hub + Math.log2(byRun.size),
      runs: byRun.size,
      ...(key.startsWith("site:") ? { url: `https://${sourceLabel(key)}` } : {}),
    });
    for (const ids of byRun.values())
      for (const s of ids) out.edges.push({ source: id, target: s, kind: "hub" });
  }
  return { v: 1, nodes: out.nodes, edges: out.edges };
}
