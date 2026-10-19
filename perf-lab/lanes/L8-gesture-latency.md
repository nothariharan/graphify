# Lane L8 — gesture latency attribution and the lean draw

Owner: subagent (deepseek-v4.1-flash-free). Metric: **felt fps during a real pointer
gesture** (drag a node, drag the canvas, zoom), plus stalled-frame count (>33ms).

## Why this lane exists
The user compared before/after and felt nothing, then rejected the WebGL/sigma spike as
ugly. The ask narrowed to the concrete complaint: *"the jitter feel while pulling,
overall feeling like a good high fps"*, and *"find where the latency is going"*.

Everything before L8 was measured with `network.moveTo()` driven from Node. That never
touches vis's pointer path, so it measured **redraw cost**, not the gesture. A gesture is
a different workload: vis hit-tests, emits hover/drag events, and redraws once per
pointermove, all on the main thread.

## Instrument (new)
- `harness/profile_drag.mjs` — runs a gesture and reports, per frame: rAF delta
  (fps/p50/p95/p99/worst/sd/jank>33/jank>50) and `beforeDrawing`→`afterDrawing` (vis's own
  draw cost), plus a CDP CPU profile attributed by function and by file.
- `harness/ab_drag.mjs` — **drift-resistant** A/B. See the trap below.
- `harness/test_synth_drag.mjs` — proves synthetic PointerEvents drive vis's real drag
  (`dragStart 1 / dragging N / dragEnd 1`, node actually moves). Gestures are therefore
  dispatched **in-page, one pointermove per rAF**, i.e. at true display cadence, instead of
  being paced by a CDP round trip (~100ms/step).
- `harness/probe_state.mjs` — camera scale, visible node count, on-screen node radius, bbox.
- `harness/mk_drag_variants.py` — derives test variants by substitution.

## The trap that invalidated two earlier conclusions
The headless machine's throughput swings **~3x between batches**: the *same file* measured
45.8 fps in one batch and 15.2 fps in another, minutes apart. No leaked Chrome processes;
the host is simply loaded. Consequences:
- A sequential "before, then after" comparison is worthless. This produced a false finding
  ("our build is 3x worse than shipped") that vanished when variants were interleaved.
- It also means the earlier claim that the hover-dataset churn caused a drag regression is
  **not supported**: with interleaving, `ours_old` (the batched build) measured **x1.00**
  against shipped on drag. The batching fix is kept as correct hygiene (N full body
  recomputes per hover -> 1), but it is not a drag win.
- An early sigma measurement used `--use-gl=swiftshader` (software WebGL) and is void.

`ab_drag.mjs` therefore runs every variant inside every round, alternating, and reports the
median fps per variant plus per-round numbers so drift is visible (a bad round moves *all*
variants together).

## Where the latency actually was
CPU attribution during a drag (rsl, 1886 nodes): ~85% of samples are **inline canvas ops**
(`stroke`, `save`, `restore`, `fill`, `arc`, `clearRect`); `vis-network.min.js` itself is
only ~14%. The JS is not the cost — the raster pipeline is. Per frame vis issues one
`ctx.save()` + `arc()` + `fill()` + **`stroke()`** + `restore()` per node: ~1900 border
strokes a frame. On this pipeline that saturates and the drag settles at ~15fps with
119 of 120 frames stalling past 33ms.

## Fix (shipped in `graphify/exporters/html.py`)
1. **Lean draw during gestures** (`_LEAN_GESTURE_JS`, gated on
   `LEAN_GESTURE_NODE_THRESHOLD = 800` nodes): on `dragStart` set
   `nodes.borderWidth = 0`, restore on `dragEnd`. vis re-applies a global
   `nodes.borderWidth` to every existing node in `setOptions`, so no dataset churn.
   Zoom has no start/end event, so lean on `zoom` and restore after 180ms of quiet,
   guarded against a drag in progress.
2. **`hideEdgesOnZoom: true`** for the same dense graphs (edges come back on release —
   the same trade `hideEdgesOnDrag` already makes).
3. **Batched arrow-hover reveal** (`_syncArrows`): the old code called `edgesDS.update()`
   once per edge, and each one makes vis recompute `_updateVisibleIndices` +
   `_updateValueRange(nodes)` + `_updateValueRange(edges)` and request a redraw. Now one
   batched update for the whole diff, suppressed during a drag, resynced on `dragEnd`.

Small graphs (<800 nodes, <1500 edges) emit none of this and are unchanged; asserted in
`tests/test_html_perf_levers.py`.

## Result — interleaved, same machine, 3 rounds, median (rsl 1886/3876)
| gesture | shipped | ours_old | ours v2 (drag lean) | **ours v3 (+ zoom lean)** |
|---|---|---|---|---|
| node drag | 15.1 fps | 15.2 (x1.00) | 59.7 | **61.6 (x4.08)** |
| pan drag | 15.5 | 15.4 (x0.99) | 56.8 | **60.3 (x3.89)** |
| zoom | 5.9 | 9.1 (x1.52) | 13.9 | **61.1 (x10.36)** |
| stall>33ms /120 | 119 | 120 | 2 | **4 / 3 / 2** |
| draw p50 zoom | 94.7ms | 32.8 | 15.3 | **12.8** |

Absolute fps is machine-state dependent (the shipped row read 45fps for the same file in
an earlier batch); the **ratio** is the durable number, which is why the A/B is interleaved.

## Scaling check — lever injected into the shipped baselines (2026-10-17)
The gsoc/continuum source `graph.json` files are gone (built in an earlier tick), so the lever
was injected into the existing baselines with `harness/inject_lean.py`; it is purely additive JS
plus one interaction option, so the artifact matches what the exporter emits.

| graph | nodes/edges | node drag | pan | zoom |
|---|---|---|---|---|
| rsl (lever alone, control) | 1886/3876 | x4.62 | x6.99 | x18.73 |
| gsoc aggregate | 2290/8045 | x3.06 | x2.40 | x16.26 |
| continuum full | 9142/27099 | x1.34 | x1.90 | x5.15 (round 2 x1.08) |

The aggregate holds up (jank 32-61/60 -> 2-4/60). Continuum does not: even with borders *and*
edges gone the draw p50 is ~56ms (an 18fps ceiling) and 40/40 frames still stall. That is above
the shippable ceiling anyway - the exporter aggregates past `MAX_NODES_FOR_VIZ` (5000), and
continuum's full 9142-node render is a lab artifact built with a forced high node limit - so the
lever is certified for everything the exporter can actually emit.

## Fix, part 2 — the lean was hiding a ~200ms hitch (2026-10-17)
`network.setOptions({nodes:{borderWidth}})` re-applies the global option to every node, but it
also costs a full synchronous redraw: measured with `harness/probe_setoptions.mjs` at ~80ms
(rsl), ~200ms (the 2290-node aggregate) and 670-2000ms (9142 nodes). That landed as one hitch at
`dragStart` and another at `dragEnd` - on rsl the lean build's **worst** frame was 188-222ms,
worse than the shipped build's own jank (125-166ms). Grabbing a node got a visible catch exactly
when the user grabs it.

The width is now written onto the node instances (`network.body.nodes[id].options.borderWidth`),
remembering each node's original so learning-status rings come back as 3px instead of 1.5px,
keeping `setOptions` as a fallback if `network.body.nodes` is ever absent, and forcing exactly one
`network.redraw()` **on restore only**. That redraw is needed because vis does not redraw at
pointer-up: `probe_borderdraw.mjs` counted **0 canvas strokes in the 20 frames after release** for
both shipped and lean builds.

Functional verification (`probe_borderdraw.mjs` patches `ctx.stroke` and the `lineWidth` setter;
`lineWidth == borderWidth / scale`, so 18.13 means a 1.5px border at the fit scale):

| build | during drag | after release |
|---|---|---|
| shipped | 26404 strokes @ lineWidth 18.13 | 5762 strokes, 1885 @ 18.13 (borders back) |
| lean via setOptions | 0 strokes, lineWidth 0 | 5762 / 1885 @ 18.13 |
| lean via node instances | 0 strokes, lineWidth 0 | 5762 / 1885 @ 18.13 - identical |

## Result — final artifact vs shipped, interleaved, 3 rounds (rsl)
`variants/base-ours-v4.html`, built through the real exporter from `worked/rsl-siege-manager/graph.json`:

| gesture | shipped | ours v4 | jank >33ms /120 |
|---|---|---|---|
| node drag | 14.7 fps | **55.5 (x3.78)** | 119 -> 3 |
| pan drag | 15.0 | **56.6 (x3.77)** | 119 -> 4 |
| zoom | 5.9 | **60.1 (x10.19)** | 121 -> 2 |

All three rounds stable (shipped 14.7/15.1/14.7, ours 50.9/55.5/56.9) - no drift to argue about.
Worst frame on the direct-mutation build: 62-76ms, down from 188-222ms with `setOptions`.

## Still open
- gsoc aggregate confirmed at x2.4-3.1 with the lean draw; continuum-class (9142 nodes) is
  unusable at any setting and only reachable by forcing a high node limit.
- The 100k tier still only renders as a community aggregate; no WebGL renderer.
- First open still solves physics (lean draw does not help load).
- `hideNodesOnDrag` exists in vis but hides *all* nodes (blank canvas) — not usable, so the
  node draw itself is still full-cost; the lean draw is the whole available win.

# Edge visibility + the batched edge pass (2026-10-17 tick 2)

The user came back with two reports: the after version's **lines disappear while zooming**,
and **also while panning by clicking and dragging the canvas**; and the speed difference is
not felt. Both are correct, and one of them was ours.

## What was hiding the edges

`hideEdgesOnZoom: true` was added by the lean-gesture work; `hideEdgesOnDrag: true` was
already in the shipped exporter and simply inherited. `probe_borderdraw.mjs` (extended with a
wheel-driven zoom mode) counts `ctx.stroke` calls and the `lineWidth` each stroke used:

| gesture | shipped (HEAD) | ours v4 (lean + both flags) | ours v5 (lean, no flags) |
|---|---|---|---|
| pan | 24240 strokes @ 18.13, **zero edges** | 0 strokes | 50388 edge strokes @ 3.63 |
| zoom | 7752 edge segments/frame | **0 strokes** | 50388 edge strokes @ 3.63 |
| node drag | 26404 border strokes, zero edges | 0 strokes | 54264 (3875 edges + border fill) |

So the shipped build already dropped every edge the moment you dragged the canvas, and the
zoom case was ours. Both flags are now gone; the graph is required to look the same in
motion as at rest.

## Why hiding them was tempting: what an edge costs

With every edge drawn, the border lean alone is only **x1.41-1.45** and the drag stays at
**89-91/90 stalled frames**. Node borders are ~1900 strokes, edges are 3876 (~30ms/frame);
canvas `stroke()` costs roughly 8-10us per call on this machine, so 5762 draw ops is a ~45ms
frame and no setting changes that. Worse, the obvious lever does not exist:

**Writing `edge.options.smooth`/`width` mid-gesture does nothing.** vis resolves the entire
draw from the live options during the draw (`Edge.draw -> getFormattingValues ->
edgeType.drawLine`), except the *curve implementation class* is chosen once in
`updateEdgeType()`, and `getFormattingValues` floors the width at `max(w, 0.3/scale)`. Proof
(`debug_edgelean.mjs`): mid-pan all 3876 edges reported `smooth:false, width:1` while the
canvas still emitted **zero `lineTo` calls** and every edge stroked at lineWidth 3.63.

Swapping the instance's `_line` for the straight implementation vis's own no-smooth class
uses does work (0 `bezierCurveTo`, 19380 `lineTo` mid-pan; node x1.73, pan x1.58, zoom
x4.14) and is kept as `variants/edge-lean-dynamic.html`, but a ceiling test that varied every
edge as **one single path** (deliberately wrong colour) hit node 42.0 / pan 42.1 / zoom
45.8fps with jank 7/90, so batching was worth building properly.

## The batched edge pass (shipped)

`_EDGE_BATCH` inside `_LEAN_GESTURE_JS`. On `dragStart`/`zoom` it groups every edge by the
**colour, dash pattern and base width** it would have been drawn with - resolved exactly the
way vis resolves them, via `e.getFormattingValues()` and `e.edgeType.getColor(ctx, t)` - then
replaces `edgeType.drawLine` per edge with one draw of all groups. `afterDrawing` (vis's own
per-frame event) resets the once-per-frame flag; `dragEnd`/the 180ms zoom timer deletes the
replacement, which restores the prototype method.

- 3876 strokes -> **20** on rsl, every edge still stroked, in its own colour, dashes kept.
- Endpoints are read **live** each frame - `edgeType.fromPoint` is the node object, so a
  batch built once at dragStart would have frozen the endpoints and broken exactly the node
  drag it is meant to help.
- `lineWidth` is re-derived per frame as `max(baseWidth, 0.3/scale)` because the floor moves
  with the zoom.
- A throwing batch calls vis's original `drawLine` instead and disables itself after 2
  errors, so a failure degrades to slow rather than blank.

`probe_edgebatch.mjs` on the shipped artifact (`base-ours-v6.html`):

| check | result |
|---|---|
| at rest | 5762 strokes, 0 lineTo (unbatched, exactly as before) |
| mid pan | **20 strokes, 3876 lineTo, 0 bezierCurveTo** |
| mid node drag | 20 strokes, 3876 lineTo; dragged node's live coord present in the drawn moveTo set |
| after release | 5762 strokes, 0 lineTo - **byte-identical to at rest** |
| colour fidelity | identical colour set vs rest (30 colours) |
| dash fidelity | dashed groups keep `[5,5]` (the only delta is vis's own `setLineDash([0])` reset call, which `save/restore` replaces) |

## Result - certified vs a fresh HEAD build, interleaved, 3 rounds (rsl)

| gesture | before (HEAD) | visible, unbatched (v5) | batched (v6) | jank >33ms /90 |
|---|---|---|---|---|
| node drag | 15.0 fps | 21.2 (x1.41) | **39.7 (x2.65)** | 89 -> 8 |
| pan drag | 15.4 | 21.2 (x1.38) | **34.9 (x2.27)** | 89 -> 16 |
| zoom | 6.3 | 21.1 (x3.35) | **36.5 (x5.79)** | 91 -> 15 |

Every line, colour and dash is drawn in all three columns - the difference is how many
`stroke()` calls it takes. Visual check mid-gesture (`shot_gesture.mjs`, screenshots taken
while the pan is still held): `shots/batch-real-pan-held.png`, `shots/batch-real-zoom-held.png`.

## Why the user may not have "felt" the earlier win

`ab_drag.mjs --mode old|new` showed the real GPU (Intel UHD via ANGLE/D3D11) in every mode -
but the *same* shipped file measured 15.0fps in round 1 and 43.7fps in round 2 of one run.
The host swings ~3x inside a single mode, so a machine sitting in the fast regime sees the
shipped build at ~44fps already and the headroom is small. Absolute fps from one run is
meaningless here; only interleaved paired ratios (D25/D38) mean anything.

# Curve fidelity: what "in motion" actually looked like (2026-10-17 tick 3)

The batched pass from tick 2 drew `moveTo(from); lineTo(to)` per edge. That is the cheapest
possible stroke and every line stays on screen - but it is not the picture the graph shows at
rest, where `smooth: {type: 'continuous', roundness: 0.2}` bends every edge slightly. On a
dense coloured graph nobody can see that by eye in a screenshot; you have to diff frames.

## How it was measured

`probe_motion_pixels.mjs`:

1. hold a pan (real pointer events) or a zoom (wheel events), camera frozen;
2. snapshot the graph canvas backbuffer;
3. release so vis redraws **the same camera** through its normal per-edge path;
4. diff the two framebuffers (count pixels whose worst channel delta > 16).

It runs on the "noborder" builds (`mk_batch_curved.py` sets `BORDER_LEAN = 1.5`, a no-op),
otherwise the legitimately-missing node borders would swamp the edge question.

| frame in motion vs same camera at rest | straight batch | curve-faithful batch |
|---|---|---|
| pan | **122454 px changed = 81.8%** of painted (worst delta 255) | **2617 px = 1.75%** (worst 79) |
| zoom | **278625 px = 103.8%** of painted (worst 255) | **3001 px = 1.12%** (worst 72) |

So "straight in motion" is not a subtle optimisation, it is a different graph: essentially
every edge pixel moved. The curve version leaves ~98% of the painted frame untouched.

The residual 1-2% is **dash phase** (`setLineDash` applies to the whole path, so grouping the
393 dashed edges into one subpath shifts each one's dash phase) plus the node endpoints, not
edge shape. Dashes are still dashes, in the same colour, on the same edges.

## Shipping it

`_curveTo` in the exporter reproduces vis's own arithmetic for `continuous` smooth edges
(`BezierEdgeDynamic._getViaCoordinates`, the fall-through branch): offset from `from` by
`roundness * dominantExtent`, signed toward `to`, then clamped into the segment's box.
Anything that is not a continuous smooth edge falls back to `lineTo`.

`probe_edgebatch.mjs` on the shipped `base-ours-v7.html`:

| check | result |
|---|---|
| at rest | 5762 strokes, **3876 quadraticCurveTo**, 0 lineTo |
| mid pan | **20 strokes**, 3876 quadraticCurveTo, 0 bezierCurveTo |
| mid node drag | 20 strokes, 3876 quadCurve, dragged node's live coord in the moveTo set |
| after release | 5762 strokes, 3876 quadCurve - identical to at rest |
| our via vs vis's `edgeType.getViaNode()` | 3876 edges checked, **worst disagreement 0.0** |
| colour set | identical to rest (30 colours) |
| dashes | dashed groups keep `[5,5]`; vis's own `setLineDash([0])` reset is replaced by save/restore |

That first row is the point of this tick: in motion the canvas emits the *same curve primitive,
the same number of times*, as it does at rest. Only the stroke count differs (3876 -> 20).

## Curves are free

An earlier 3-variant run made curves look 13-36% slower on pan/zoom. That was round drift:
round 3 of the next run dipped both variants together. In one interleaved run (same rounds,
same host):

| variant | node | pan | zoom |
|---|---|---|---|
| straight batch | 79.4 | 69.3 | 78.5 |
| curve-faithful batch | **82.9** | **78.9** | **80.4** |

## Final certification, `results/ab-rsl-v7-certified.csv` (3 rounds, rsl, vs a fresh HEAD build)

| gesture | before (HEAD) | shipped (v7) | stalled >33ms /90 |
|---|---|---|---|
| node drag | 40.4 fps | **82.9 (x2.05)** | 13 -> 1 |
| pan drag | 39.1 | **78.9 (x2.02)** | 14 -> 1 |
| zoom | 15.2 | **80.4 (x5.29)** | 91 -> 0 |

The `before` column is running fast in this run (40fps where the earlier certification measured
15). That is the host regime, not the code: the same shipped file measured 15.0 and 43.7fps in
consecutive rounds of one mode-new run. The paired ratio across all certified runs of this lever
spans **x1.7-x5.8**; the honest claim is the ratio and the stall count, never a bare fps.
