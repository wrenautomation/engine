/**
 * Nested layout over a fold: each open container lays out its kids once, an open kid's size is its
 * own layout plus padding, and positions add up to the root. The engine is the caller's (ELK,
 * a grid, metro's placement): orrery only orders the calls, sizes the containers and caches.
 */
import type { FoldNode } from "./tree.js";

export interface Size {
  w: number;
  h: number;
}

/** A kid as the engine gets it: open kids are sized by their own layout. */
export interface Kid extends Size {
  id: string;
  open: boolean;
}

/** One container's layout, kid positions relative to its content box. `extra`: the engine's own (edge routes). */
export interface Laid<T = unknown> extends Size {
  at: Readonly<Record<string, readonly [x: number, y: number]>>;
  extra?: T;
}

export type Engine<T> = (container: string, kids: readonly Kid[]) => Promise<Laid<T>>;

/** Room an open container keeps around its kids: a title bar on top. */
export interface Pad {
  top: number;
  side: number;
  bottom: number;
}

/** A box on the canvas, absolute. `parent`: the open container it is drawn in. */
export interface Placed extends Size {
  id: string;
  x: number;
  y: number;
  open: boolean;
  parent?: string;
}

/** An open container's layout, with the absolute origin of its content box. */
export interface Level<T> {
  id: string;
  x: number;
  y: number;
  laid: Laid<T>;
}

export interface Nested<T> extends Size {
  /** Parents before their kids. */
  boxes: Placed[];
  levels: Level<T>[];
}

/** Layouts by container and input; a fold re-lays only the containers on the changed path. */
export type NestCache<T> = Map<string, Laid<T>>;

export async function nest<T>(o: {
  nodes: readonly FoldNode[];
  /** The container drawn as the canvas: always laid out, never a box. Its kids name it as parent. */
  root: string;
  /** From `openSet`: the containers that show open. */
  open: ReadonlySet<string>;
  /** A closed box's size. */
  size(id: string): Size;
  pad: Pad;
  engine: Engine<T>;
  cache?: NestCache<T>;
}): Promise<Nested<T>> {
  const kids = new Map<string, string[]>();
  for (const n of o.nodes)
    if (n.parent) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent))?.push(n.id);
  const opens = (id: string) => o.open.has(id) && (kids.get(id)?.length ?? 0) > 0;
  const laid = new Map<string, Laid<T>>();

  const lay = async (id: string): Promise<Laid<T>> => {
    const list = await Promise.all(
      (kids.get(id) ?? []).map(async (k): Promise<Kid> => {
        if (!opens(k)) return { id: k, ...o.size(k), open: false };
        const in_ = await lay(k);
        return {
          id: k,
          w: Math.max(o.size(k).w, in_.w + 2 * o.pad.side),
          h: in_.h + o.pad.top + o.pad.bottom,
          open: true,
        };
      }),
    );
    const key = `${id}\0${JSON.stringify(list)}`;
    const hit = o.cache?.get(key) ?? (await o.engine(id, list));
    o.cache?.set(key, hit);
    laid.set(id, hit);
    return hit;
  };
  const top = await lay(o.root);

  const boxes: Placed[] = [];
  const levels: Level<T>[] = [];
  const place = (id: string, x: number, y: number, parent?: string) => {
    const l = laid.get(id) as Laid<T>;
    levels.push({ id, x, y, laid: l });
    for (const k of kids.get(id) ?? []) {
      const [kx, ky] = l.at[k] ?? [0, 0];
      const open = opens(k);
      const inner = open ? (laid.get(k) as Laid<T>) : undefined;
      const s = inner
        ? {
            w: Math.max(o.size(k).w, inner.w + 2 * o.pad.side),
            h: inner.h + o.pad.top + o.pad.bottom,
          }
        : o.size(k);
      boxes.push({ id: k, x: x + kx, y: y + ky, ...s, open, ...(parent ? { parent } : {}) });
      if (inner) place(k, x + kx + (s.w - inner.w) / 2, y + ky + o.pad.top, k);
    }
  };
  place(o.root, 0, 0);
  return { w: top.w, h: top.h, boxes, levels };
}
