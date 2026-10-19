# Lane L5 — huge-graph representation (culling / aggregate / worker / WebGL)

Owner: subagent (deepseek-v4.1-flash-free). Primary metric: load_ms + redraw_min + whether
it opens at all.

## Brief
continuum 9142/27099 = 11MB, load 31.2s, redraw 2173ms. gsoc 104260/292661 = 131MB,
build 15.8s, unopenable. vis-network 9.1.6 is canvas-2D only (no WebGL flag). Obsidian
uses Pixi.js WebGL + LOD labels + no on-load physics + persisted positions; sigma.js is
the Obsidian-like alternative. Corroboration: obsidian-extended-graph #170 (smoother with
HW accel off) — the win is the render strategy, not GPU fill.
Capability at stake: the full topology must remain reachable (blast radius / connectivity).

## Options to prototype
1. Viewport culling: only keep nodes/edges intersecting the camera (vis already culls draw,
   but init/layout still pays for all). Aggregate off-screen.
2. Aggregate-at-scale: draw communities as super-nodes, expand on zoom (keeps reachability).
3. Physics in a Web Worker, or no physics at scale + baked positions.
4. WebGL renderer (sigma.js/Pixi) only for the extreme tier, with a simpler visual language.

## Steps
1. continuum subset sweep (v00/v01/v13/v18, dpr1) to see which levers scale.
2. Prototype culling count: how many nodes/edges are in-view at default zoom?
3. Decide threshold (MAX_NODES_FOR_VIZ=5000, html.py L14) behavior at >50k.

## Status
CONTINUUM FULL MEASURED (9142/27099, dpr1, warm):
- baseline redraw_min 176, **p95 997**, load 8608, pan 2.4fps, zoom 5.6, **longtask_total 12733ms**.
- v13-hover-arrows 58.9 (-67%), v12-edges-lean 45.2 (-74%), v10-lean 47.9 (-73%) load 1123 (-87%),
  v04-straight 103.7 (-41%). Redraw levers scale; load needs baked positions (nosim alone hurts fps).

GSOC 104260 PROTOTYPED (2026-10-16 tick4):
- Full graph cannot render. Shipped fallback = community aggregate: **2290 nodes / 8045 edges**, 2.4 MB,
  load 2760, opens - but LAGGY: rwmin 177, pan 2.0fps. Dense edges (3.5/node) are the cost, not node count.
- Shippable: v13-hover-arrows 65.5 (x0.37), **v21-hover-straight 57.8 (x0.33)**, v19-baked load 736
  (x0.27) + rwmin 52.6. Unshippable floor v12 (no arrows+dashes) 33.5 (x0.19).
- OPEN: pan stuck ~3fps on the aggregate with every shippable combo -> needs viewport edge-culling /
  progressive edge reveal (no vis-network option exists; would be a renderer change).
Next: item 5 L6 integration.
