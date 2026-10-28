/**
 * The glide between two frames of a map (a depth step, a node opened or folded), from wren's metro
 * map. Marks that stay slide and scale to their new place, marks that appear grow out of the
 * anchor, marks that go shrink into it. Imperative: it measures the DOM after the renderer
 * commits and uses the Web Animations API, so it costs no re-render. Which elements are marks is
 * the renderer's (`Marks`).
 */

export type Point = readonly [x: number, y: number];

const EASE = "cubic-bezier(.22,1,.36,1)";
export const GLIDE_MS = { move: 460, fade: 180, shrink: 380 } as const;

export interface Marks {
  /** Selector for every element that can glide. */
  select: string;
  /** Its key across frames. Null: it cannot glide. */
  key(el: Element): string | null;
  /** Selector for lines and other parts that fade in under the marks. */
  fresh?: string;
  /** Keys that keep their width (metro's hub). */
  fixedWidth?(key: string): boolean;
  /** Map units in one screen px for a frame: a transform on a mark is in its map's units. */
  units?(frame: Element): number;
}

export interface Box {
  n: Element & ElementCSSInlineStyle;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Whether this environment can measure and animate. happy-dom cannot. */
const canGlide = (n: Element) =>
  typeof n.getBoundingClientRect === "function" && typeof n.animate === "function";

/** Every mark of a frame, with its centre and size on the screen, in screen px. */
export function snapshot(frame: Element | null | undefined, marks: Marks): Map<string, Box> {
  const out = new Map<string, Box>();
  if (!frame) return out;
  for (const n of frame.querySelectorAll<Element & ElementCSSInlineStyle>(marks.select)) {
    const k = marks.key(n);
    if (!k || !canGlide(n)) continue;
    const b = n.getBoundingClientRect();
    out.set(k, { n, x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height });
  }
  return out;
}

/** The centre of an element on the screen: where a group grows from. */
export function centreOf(n: Element | null): Point | null {
  if (!n || typeof n.getBoundingClientRect !== "function") return null;
  const b = n.getBoundingClientRect();
  return [b.left + b.width / 2, b.top + b.height / 2];
}

/** SVG: from the screen matrix. Else 1; an HTML renderer under a scale passes its own. */
function svgUnits(frame: Element): number {
  const a = (frame as SVGSVGElement).getScreenCTM?.()?.a;
  return a ? 1 / a : 1;
}

const origin = (n: ElementCSSInlineStyle) => {
  n.style.transformBox = "fill-box";
  n.style.transformOrigin = "center";
};

/**
 * Play the new frame from `before` (a snapshot taken before the renderer committed). Same-DOM
 * renderers (a FLIP) call this; marks that went are already gone. Returns the glide's length in ms.
 */
export function play(o: {
  before: Map<string, Box>;
  next: Element;
  marks: Marks;
  anchor?: Point | null | undefined;
  anchorKey?: string | null | undefined;
}): number {
  const after = snapshot(o.next, o.marks);
  const k = (o.marks.units ?? svgUnits)(o.next);
  const to = o.anchorKey ? after.get(o.anchorKey) : undefined;
  const anchor: Point | null = to ? [to.x, to.y] : (o.anchor ?? null);
  if (o.marks.fresh)
    for (const n of o.next.querySelectorAll(o.marks.fresh))
      n.animate?.([{ opacity: 0 }, { opacity: 1 }], {
        duration: 320,
        delay: 80,
        easing: "ease-out",
        fill: "backwards",
      });
  for (const [key, a] of after) {
    const prev = o.before.get(key);
    origin(a.n);
    if (prev) {
      const sx = o.marks.fixedWidth?.(key) ? 1 : prev.w / a.w;
      const sy = prev.h / a.h;
      const moved = Math.abs(prev.x - a.x) > 0.5 || Math.abs(prev.y - a.y) > 0.5;
      if (moved || Math.abs(sy - 1) > 0.02 || Math.abs(sx - 1) > 0.02)
        a.n.animate(
          [
            {
              transform: `translate(${(prev.x - a.x) * k}px,${(prev.y - a.y) * k}px) scale(${Math.abs(sx - 1) > 0.02 ? sx : 1},${Math.abs(sy - 1) > 0.02 ? sy : 1})`,
            },
            { transform: "none" },
          ],
          { duration: GLIDE_MS.move, easing: EASE },
        );
    } else if (a !== to) {
      // It grows out of the anchor, the way a closing mark goes back in.
      const [ax, ay] = anchor ?? [a.x, a.y];
      a.n.animate(
        [
          { opacity: 0, transform: `translate(${(ax - a.x) * k}px,${(ay - a.y) * k}px) scale(.4)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: GLIDE_MS.move, delay: 40, easing: EASE, fill: "backwards" },
      );
    } else {
      // The mark a group folds into fills in as its kids reach it.
      a.n.animate(
        [
          { opacity: 0, transform: "scale(.6)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: GLIDE_MS.move, delay: GLIDE_MS.shrink * 0.4, easing: EASE, fill: "backwards" },
      );
    }
  }
  return GLIDE_MS.move;
}

/**
 * Glide from `old` (a copy of the last frame, laid over the map) to `next` (the live frame).
 * Marks that go shrink into the anchor; the rest of the old frame fades. Returns how long the old
 * frame must stay, in ms.
 */
export function glide(o: {
  old: Element;
  next: Element;
  marks: Marks;
  anchor?: Point | null | undefined;
  anchorKey?: string | null | undefined;
}): number {
  const before = snapshot(o.old, o.marks);
  const after = snapshot(o.next, o.marks);
  const kOld = (o.marks.units ?? svgUnits)(o.old);
  const to = o.anchorKey ? after.get(o.anchorKey) : undefined;
  const anchor: Point | null = to ? [to.x, to.y] : (o.anchor ?? null);
  const gone = [...before].filter(([k]) => !after.has(k)).map(([, b]) => b);
  for (const [k, b] of before) if (after.has(k)) b.n.style.opacity = "0";
  const goneSet = new Set<Element>(gone.map((b) => b.n));
  for (const c of o.old.children) {
    if (goneSet.has(c) || gone.some((b) => c.contains(b.n))) continue;
    c.animate?.([{ opacity: 1 }, { opacity: 0 }], {
      duration: GLIDE_MS.fade,
      easing: "ease-out",
      fill: "forwards",
    });
  }
  for (const b of gone) {
    const [ax, ay] = anchor ?? [b.x, b.y];
    origin(b.n);
    b.n.animate(
      [
        { opacity: 1, transform: "none" },
        {
          opacity: 0,
          transform: `translate(${(ax - b.x) * kOld}px,${(ay - b.y) * kOld}px) scale(.4)`,
        },
      ],
      { duration: GLIDE_MS.shrink, easing: EASE, fill: "forwards" },
    );
  }
  play({ before, next: o.next, marks: o.marks, anchor, anchorKey: o.anchorKey });
  return gone.length ? GLIDE_MS.shrink : GLIDE_MS.fade;
}

/** Fade the new frame in when there is nothing to glide from (reduced motion). */
export function fadeIn(next: Element): void {
  next.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
}

/** The map's own height eases between two frames. */
export function glideHeight(host: HTMLElement, from: number, to: number): void {
  if (from === to) return;
  host.animate?.([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: GLIDE_MS.move,
    easing: EASE,
  });
}
