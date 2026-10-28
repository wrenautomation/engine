# orrery

The logic of a map you fold. No renderer, no framework: each map draws its own frames.

- `tree`: the fold tree. A depth cut, plus nodes opened or closed by hand. `openSet`, `toggle`, `reveal`, `stepDepth`, `fullDepth`.
- `nest`: nested layout over an engine you pass (ELK, a grid, your own). Open containers are sized by their kids. Positions add up to the root. A cache re-lays only the changed path.
- `glide`: the motion between two frames. Marks that stay slide, new ones grow out of an anchor, gone ones shrink into it. `Marks` says which elements are marks.

Depends on nothing. Runs in a browser: `glide` measures the DOM and uses the Web Animations API.

```sh
npm i @wrenautomation/orrery
```

```ts
import { nest, openSet } from "@wrenautomation/orrery";

const open = openSet(nodes, { depth: 1, open: { "pkg:core": true } });
const map = await nest({ nodes, root: "repo", open, size, pad, engine: myLayout });
// map.boxes: absolute, parents first. map.levels: each open container's own layout.
```

Used by kestrel's viewer and wren's metro map.
