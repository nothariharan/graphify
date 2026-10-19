# Graphify graph-view performance — final report

Loop: 2026-10-16, branch `perf/graph-view-lag`, no PR opened. All measurements are
real headless-Chrome runs (unthrottled ~143 fps) recorded in `results/measurements.csv`;
the canonical metric is `redraw_min` (fixed camera) plus `load_ms`.

## What the lag actually was

Two separate costs, not one:

1. **Per-frame redraw** — dominated by drawing an arrowhead on *every* edge on *every*
   frame. Cost scales with edge count.
2. **On-open load** — the on-load physics stabilization (`stabilization:{iterations:200}`).

Interaction fps also collapses at scale, but the pan/zoom fps numbers are only
comparable within a variant (see "Instrument" below).

## Certified levers (capability-preserving)

### 1. Deferred arrowheads (arrows on hover) — the redraw lever
Direction is not removed; arrowheads are drawn on the hovered edge and on all edges
incident to a hovered node.

| graph | nodes/edges | baseline `redraw_min` | with lever | ratio |
|---|---|---|---|---|
| rsl | 1886 / 3876 | 21.1 ms | 7.6 ms | **x0.36** |
| rsl (same session) | 1886 / 3876 | 80.5 ms | 24.2 ms | **x0.30** |
| continuum full | 9142 / 27099 | 176.1 ms | 58.9 ms | **x0.33** |
| gsoc aggregate | 2290 / 8045 | 177.3 ms | 65.5 ms | **x0.37** |
| gsoc agg, straight+hover (v21) | 2290 / 8045 | 177.3 ms | 57.8 ms | **x0.33** |

Shipped default (density-gated: edges > 1500 defer) on rsl, same session:
redraw x0.30, `longtask_total` 5487 ms -> 55 ms, zoom fps 12.0 -> 50.8.

### 2. Stabilized-layout cache — the load lever
First open is unchanged; a re-open skips the solver because the cached x/y *are* that
graph's own stabilized positions.

- reopen probe (rsl, shipped default): time-to-physics-off **6134 ms -> 66 ms (-99%)**.
- build-time bake (`harness/bake.mjs`), independent check: rsl load 2437 -> 639 (**-74%**),
  gsoc aggregate 2760 -> 736 (**-73%**); identical viewport/scale, arrows/dashes/communities intact.
- on-load physics off entirely (upper bound): rsl load -85%, continuum -86%.

### 3. Offline bundle fallback
The CDN `<script>` now falls back to a sibling `vis-network.min.js` on error. L1 proved
the failure mode: blocking the CDN leaves `vis is not defined` and a blank page.

## Measured non-levers (~0 redraw impact)
Dashes, hover on/off, labels, `improvedLayout`, device-pixel-ratio (dpr2 gave +2%, so the
cost is CPU geometry-bound, not fill-bound), arrowhead *type* (vee/bar/circle), and
`smooth:'dynamic'` (rejected: load exploded to 9590 ms). `smooth:'discrete'` was
DPR-unstable and demoted.

## Shipped changes (in the working tree, not committed)
- `graphify/exporters/html.py` — `ARROW_DEFER_EDGE_THRESHOLD`, density-gated arrowhead
  deferral + hover reveal (ref-counted), always-on stabilized-layout cache, CDN->local
  fallback.
- `tests/test_html_perf_levers.py` — new regression tests. Existing suite: 113 passed;
  plus the new file, 25 passed on the touched subset.

## Instrument
- `measure.mjs` was fixed mid-loop to drive the camera by elapsed time (lane `L2t`);
  before that, a slower variant took a different path and fps was not cross-comparable.
  `redraw_min` and `load_ms` are valid across all rows; pan/zoom/hover fps only within a variant.
- Some host sessions were saturated (continuum baseline once reported 52 s vs 8.6 s), so
  every headline ratio above is same-session.

## Still open (not done)
1. **Dense-graph pan (~3 fps)** on the 8045-edge gsoc aggregate under every shippable
   combo. This needs viewport edge-culling / progressive edge reveal — a renderer change
   with no vis-network option (the unshippable floor, dropping arrows+dashes, reached
   33.5 ms, x0.19, showing how much is edge-drawing).
2. **104k full node-level view** — only reachable today via the aggregate or `--obsidian`.
   No WebGL renderer (sigma.js/Pixi) was integrated.
3. **First-open cost is unchanged** (rsl ~2.4 s / continuum ~8.6 s stabilization). Only
   re-opens are cached. Moving first-open offline would need a build-time bake.
