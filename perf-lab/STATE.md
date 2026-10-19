# STATE — loop memory

Updated by each loop tick. Read this first, then continue the next lane.

## Phase
**Phase 4b — gesture smoothness on vis-network (CURRENT).** Phase 4 tried a WebGL renderer
(sigma.js): the numbers were decisive (pan 4.8 -> 90-110fps) but the **user rejected it as
ugly** and it would have needed a full rewrite (no arrowheads, legend, search, hyperedges,
aggregate path). The ask narrowed to the concrete felt complaint: *jitter while pulling*.
Lane L8 did real latency attribution and found the answer inside vis: per-frame
`ctx.stroke()` calls - ~1900 node borders plus 3876 edges - were saturating the raster
pipeline. Two gesture-only levers now ship: **borders off the nodes** and **one batched
stroke per (colour, dash, width) group for the edges** (3876 strokes -> ~20). Every node
and every edge is still drawn, in its own colour, with its dashes; nothing is hidden.

Certified on the real exporter artifact vs a fresh HEAD build, interleaved, 3 rounds:
**node drag 40.4 -> 82.9fps (x2.05), pan 39.1 -> 78.9 (x2.02), zoom 15.2 -> 80.4 (x5.29)**,
stalled frames (>33ms) 13-91/90 -> 0-1/90. The batch draws the same curve vis draws at rest,
so a frame in motion is 98%+ the same pixels as a frame at rest. A round earlier the user
reported that edges *vanished* while panning/zooming: `hideEdgesOnDrag`/`hideEdgesOnZoom` were
both removed, and the batch is the replacement - all lines visible, drawn cheaper.

Phase 4/sigma is parked in lane L7. Phases 2/3 (lever discovery + integration) are complete.

## Model / constraints
- Only `opencode/deepseek-v4.1-flash-free` (provider instance `opencode`), incl. subagents.
- No web search / external services.
- Perf only; must NOT reduce capability (nodes/edges/communities/direction/confidence/connectivity).
- Log everything; no PR; implement in exporter after insight; final report when exhausted.

## Findings (rsl 1886/3876, dpr1, redraw_min; warm)
Baseline 21.1 / load 3020.
- **Arrows on hover only (v13)**: redraw 7.6 (**-64%**), pan 35.2, zoom 115.6. Capability kept (direction on hover).
- **No in-browser stabilization (v01 nosim)**: load 3020 -> 368 (**-88%**). Layout quality traded unless positions baked.
- **Straight edges (v04)**: redraw 13.6 (-36%). Aesthetics-only.
- **Discrete smooth (v18)**: 19.7 (-13%). Minor.
- Arrow *type* does not help: vee 21.2, bar 21.7, circle 23.1.
- Dashes (v03 21.7), hover (v05 21.8), labels (v06 22.0), improvedLayout (v08 21.6): ~0.
- DPR is not a factor: dpr2 (4x pixels) redraw 23.0 vs dpr1 22.5. **CPU geometry-bound, not fill-bound.**
- `smooth:'dynamic'` (v17) blows up load to 9.6s — avoid.

## Decision
Lead with: (1) arrows-on-hover default, (2) bake positions (stabilize once, ship x/y,
physics off), (3) keep capability. Aesthetics levers (straight/discrete) optional.

## Next (Phase 4b — gesture smoothness)
1. [DONE 2026-10-17] L8 instrument: `profile_drag.mjs` (per-frame rAF deltas + vis draw cost
   + CDP CPU profile), `test_synth_drag.mjs` (proved synthetic PointerEvents drive vis's real
   drag), `probe_state.mjs`, `mk_drag_variants.py`.
2. [DONE] L8 attribution: during a drag ~85% of CPU is inline canvas ops (stroke/save/restore/
   fill/arc) and only ~14% is vis JS. One `save+arc+fill+stroke+restore` per node per frame,
   ~1900 border strokes on rsl -> raster pipeline saturation.
3. [DONE] L8 fix shipped in the exporter: lean gesture draw (`borderWidth` 1.5 -> 0 during
   drag, and during zoom via a 180ms idle timer), `hideEdgesOnZoom: true`, batched arrow-hover
   sync. Gated at 800 nodes / 1500 edges so small graphs are unchanged.
4. [DONE] Measured interleaved (3 rounds, median, rsl): node drag x4.08, pan x3.89, zoom
   x10.36, stalls 119/120 -> 2-4/120. `tests/test_html_perf_levers.py` 12 tests pass; full
   suite 8068 passed / 7 pre-existing unrelated failures.
5. [DONE 2026-10-17] Scaled the lean lever, then fixed a hitch it was hiding.
   - rsl control (lever alone, injected into the shipped baseline): node x4.62, pan x6.99,
     zoom x18.73. gsoc aggregate (2290/8045): node x3.06, pan x2.40, zoom x16.26, jank 32-61/60
     -> 2-4/60. continuum (9142/27099): only x1.3-1.9 and still janks every frame -> that is
     ABOVE the shippable ceiling (the exporter aggregates past 5000 nodes), so it is the known
     open item, not a regression from this work.
6. [DONE 2026-10-17] Lean shape fix - `network.setOptions({nodes:{borderWidth}})` costs a full
   synchronous redraw (measured ~80ms rsl, ~200ms 2290-node aggregate, 670-2000ms at 9142), so it
   landed as one hitch at dragStart and another at dragEnd; on rsl the lean build's worst frame
   (188-222ms) was WORSE than the graph's own jank. The width is now written straight onto the
   node instances, remembering each node's original (learning-status nodes carry a 3px ring),
   with setOptions kept as a fallback and one explicit redraw on restore only - vis does not
   redraw on pointer-up (measured: 0 canvas strokes in the 20 frames after release).
   - rsl worst frame 188-222 -> 62-76ms; direct-mutation A/B vs shipped: node x3.16, pan x3.01,
     zoom x8.59, draw p95 17.3 -> 9.4 (node).
   - final artifact (`base-ours-v4.html`, real exporter) vs shipped, 3 rounds, all stable:
     node 14.7 -> 55.5 (**x3.78**), pan 15.0 -> 56.6 (**x3.77**), zoom 5.9 -> 60.1 (**x10.19**),
     jank 119-121/120 -> **2-4/120**.
   - border probe on the shipped artifact: during a drag 0 strokes / lineWidth 0 (was 26404
     strokes at lineWidth 18.13); after release byte-identical to shipped (5762 strokes, 1885 at
     18.13 = borders restored).
   - `tests/test_html_perf_levers.py` 14 tests pass; `harness/chart.py` re-run;
     `view/after.html` rebuilt from the v4 artifact.
7. [NEXT] Check whether the same lean trick helps the on-load physics settle (the last
   non-cached first-open cost).
8. [PARKED] WebGL renderer (lane L7). Numbers were great; user rejected the look.
9. [DONE 2026-10-17] Reported the before/after to the user with the live links
   (`view/before.html` vs `view/after.html`); user reported back that **edges vanished while
   zooming and while panning** and that the speed difference was not felt.
10. [DONE 2026-10-17] Edge visibility regression, fixed at the source and then made cheap:
    - `hideEdgesOnZoom` (added by us) and `hideEdgesOnDrag` (shipped default, inherited) are
      both gone. Probe over before/v4/v5/v6 proves it stroke-by-stroke: during a pan, before =
      24240 strokes @ lineWidth 18.13 (borders only, ZERO edges), v4 = 0 strokes, v6 = 50388
      edge strokes @ 3.63; during a zoom, before = 7752 edge strokes, v4 = 0, v6 = 50388.
    - Edges visible then cost most of the win (v5: node x1.41, pan x1.45, zoom x3.41 but still
      89-91/90 stalled frames), so the edge pass itself had to get cheaper.
    - Straight-in-motion was tried and kept as an option (`edge-lean-dynamic.html`, x1.52-3.95)
      but superseded by the batch below.
11. [DONE 2026-10-17] Batched edge pass (`_EDGE_BATCH` in `_LEAN_GESTURE_JS`): for the length of
    a gesture, `edgeType.drawLine` is replaced per edge by one draw of every edge, grouped by the
    colour/dashes/width it would have been drawn with (3876 strokes -> 20 on rsl). Endpoints are
    read live each frame (`edgeType.fromPoint` IS the node object), so dragged-node edges follow.
    - Why not "just write options.smooth/width": vis resolves the whole draw from the instance
      options *during* the draw (`Edge.draw -> getFormattingValues -> edgeType.drawLine`), and the
      curve class is chosen once in `updateEdgeType()`. Proven dead: mid-gesture all 3876 edges
      reported `smooth:false, width:1` while the canvas still emitted 0 `lineTo` and lineWidth 3.63.
    - Fidelity probe (`probe_edgebatch.mjs`): 20 strokes mid-gesture while all 3876 edges are
      still stroked, colour set identical to rest (30 colours both), dashed groups keep [5,5],
      after release identical to unbatched (5762 strokes, same curve count), dragged node
      coordinate present in the drawn set.
    - Certified vs HEAD: node x2.65, pan x2.27, zoom x5.79, stalls 8-16/90.
12. [DONE 2026-10-17] Curve fidelity - the batch now draws the *same curve* vis draws at rest,
    not a straight line. Straight lines are faster but they are a visibly different graph in
    motion, and the way to see that is a pixel diff, not an eye test:
    - `probe_motion_pixels.mjs` snapshots the graph canvas while the gesture is still held
      (camera frozen), releases so vis redraws the same camera through its own per-edge path,
      and compares framebuffers. Run on the "noborder" builds (`mk_batch_curved.py`, where the
      lean is a no-op) so the two frames differ ONLY by the edge pass.
    - pan: straight **81.8%** of painted pixels changed (worst delta 255) vs curved **1.75%**
      (worst 79). zoom: straight **103.8%** vs curved **1.12%**. The residual is dash phase
      (dashes are per-path, so grouping shifts the phase of the 393 dashed edges) plus node
      endpoints, not geometry.
    - `_curveTo` reproduces `BezierEdgeDynamic._getViaCoordinates` for `continuous` smooth
      edges; `probe_edgebatch.mjs` checks the arithmetic against `edgeType.getViaNode()` for all
      3876 edges: **worst disagreement 0.0**. Non-continuous types fall back to a line.
    - Cost is inside the noise floor: in the same interleaved run straight vs curved was
      79.4/69.3/78.5 vs **82.9/78.9/80.4** fps (node/pan/zoom) - the curved build is not slower.
    - Final certification (`results/ab-rsl-v7-certified.csv`, 3 rounds, vs a fresh HEAD build):
      node 40.4 -> **82.9 (x2.05)**, pan 39.1 -> **78.9 (x2.02)**, zoom 15.2 -> **80.4 (x5.29)**,
      stalled frames 13-91/90 -> **0-1/90**. Mid-gesture shots: `shots/curved-pan-held.png`,
      `shots/curved-zoom-held.png`; `view/after.html` rebuilt from `base-ours-v7.html`.

13. [DONE 2026-10-19] Committed the gesture work and moved the loop into its own worktree so the
    user's checkout stays clean and later agents inherit the state: local commit `3a09ba73` on
    `perf/graph-view-lag`, worktree branch `perf/graph-smoothness` at
    `C:\Users\HARIHARAN\.t3\worktrees\Graphify\perf-graph-smoothness`. `perf-lab/` (harness, CSVs,
    lane docs, vendored vis) is now tracked; generated artifacts (`variants/`, `view/`, `work/`,
    `results/chart.html`) stay gitignored and were copied in. Exporter hash verified unchanged
    (`3306ea51…`), `tests/test_html_perf_levers.py` 20 pass in the worktree, both served pages
    smoke clean from the worktree.
14. [DONE 2026-10-19] Wrote `perf-lab/AGENTS.md`, the handoff protocol: the ask in the user's
    words, the hard rules (capability never reduced; edges never hidden in a gesture; in-motion
    must match at-rest; model pin; no PR/push), the measurement contract, the evidence registry
    (which file a finding must land in), the lane board, a tick recipe, definition of done, the
    traps already paid for, and a first-10-minutes checklist.
15. [DONE 2026-10-19] `harness/bench_lock.py`: an exclusive gate so parallel agents cannot
    corrupt each other's numbers. `run --why "..." -- <cmd>` holds the lock for the child's
    lifetime, releases, and appends to `results/bench-runs.log` (the audit trail of every
    measurement in this lab). Verified: exclusion holds (a second agent blocks), stale locks are
    stolen after 20 min, `--force` steals now. Fixed a real bug found while testing: the steal
    path detected a dead holder but never removed the file, so it waited forever.
16. [ACTIVE 2026-10-19] Three lanes dispatched as child agents (model-pinned
    `opencode/deepseek-v4.1-flash-free`), each pointed at `AGENTS.md` as its binding contract,
    lane-prefixed filenames, and told not to touch `graphify/exporters/html.py`:
    - **L9** node-draw batching — taskId `…graphify-perf-L9-r1`.
    - **L10** instant first open (bake the layout at export) — taskId `…graphify-perf-L10-r1`.
    - **L11** viewer experience (focus/fly-to/HUD/legend) — taskId `…graphify-perf-L11-r1`.
    The loop owner integrates a winner only after its lane doc + CSV + parity proof exist.

## Tick status
2026-10-19 (restructure + lanes L9-L11): the felt-smoothness work was committed (`3a09ba73`)
and the loop moved into its own worktree (`perf/graph-smoothness`), so the user's checkout is
clean and any later agent can pick this up from a branch instead of a dirty tree. `perf-lab/`
is now tracked and `AGENTS.md` is the handoff protocol: hard rules, the measurement contract,
the evidence registry, the lane board, the traps, and a first-10-minutes checklist. Every
measurement now goes through `harness/bench_lock.py` (audited in `results/bench-runs.log`), so
parallel agents cannot silently corrupt each other's numbers — verified by blocking a second
agent while one held the lock. The 30-minute loop is armed in this thread. Three lanes are
running as child agents: L9 (nodes are now the frame floor), L10 (instant first open), L11
(viewer experience). Next tick: integrate whichever lane has a measured, parity-proved winner
into `graphify/exporters/html.py`, or take the next STATE item if the lanes are still running.

2026-10-17 tick 3 (curve fidelity): the batch shipped in tick 2 drew straight lines during a
gesture, which is cheap but is a different picture from the resting graph. `probe_motion_pixels.mjs`
held a pan/zoom, snapshotted the canvas, released it so vis redrew the same camera, and diffed:
straight changed 82-104% of painted pixels, the curve-faithful batch 1.1-1.8%. `_curveTo` now
reproduces vis's own continuous-smooth via point (verified against `getViaNode()` on all 3876
edges, 0 disagreement) and costs nothing measurable (straight 79.4/69.3/78.5 vs curved
82.9/78.9/80.4 fps node/pan/zoom in one interleaved run). Certified on `base-ours-v7.html`:
node 40.4 -> 82.9 (x2.05), pan 39.1 -> 78.9 (x2.02), zoom 15.2 -> 80.4 (x5.29), stalls 13-91/90
-> 0-1/90. `tests/test_html_perf_levers.py` 20 tests pass; both served pages smoke clean;
`view/after.html` is v7. Next tick: item 7 (does the lean help the on-load physics settle).

2026-10-17 tick 2 (edge visibility + edge cost): the user reported two things - lines disappear
while zooming (our `hideEdgesOnZoom`) and while panning (`hideEdgesOnDrag`, a shipped default),
and the speed-up is not felt. Both hide flags are now removed (items 10-11) and the edges are
made cheap instead of absent: a batched edge pass takes a drag/zoom frame from 3876 `stroke()`
calls to ~20 while keeping every line, colour and dash (probe-verified), certified at node
x2.65 / pan x2.27 / zoom x5.79 with 8-16/90 stalled frames vs 89-91. Also measured why the
"not felt" report is plausible: the host swings ~3x between rounds even inside one render mode
(mode=new round 1 vs round 2 on the *same* shipped file: 15.0fps vs 43.7fps), so on a machine
sitting in the fast regime the shipped build is already ~44fps and the headroom is smaller.
Interleaved A/B is the only valid comparison; absolute fps from a single run is not.
`tests/test_html_perf_levers.py` 19 tests, all pass (broader `-k "html or exporter or viz"`:
133 passed, 1 pre-existing environmental failure = `test_hooks.py` shells out to `sh` on Windows).

## Archived: Phase 4 items (WebGL spike — parked, lane L7)

## Archived: Phase 2/3 items (all DONE)
1. [DONE 2026-10-16] Replicated rsl (reps=4, min): hover-arrows v13 7.6/7.8 vs baseline 21.1/21.5
   = **x0.36 (-64%)** at dpr1 and dpr2; no-sim load 368/364 vs 2438/2263 = **-85%**.
   v02-noarrows 7.4 (x0.35), v12-edges-lean 6.0 (x0.28), v04-straight 13.2 (x0.63).
   v18-smooth-discrete 19.7 (x0.93) at dpr1 but 22.1 at dpr2 -> NOT reliable, demoted.
2. [DONE 2026-10-16] Tier fix: `base-continuum.html` was the AGGREGATE (283/1758) mislabelled as
   continuum; renamed to `base-cagg.html`, rows relabelled to graph=cagg. New `harness/build_base.py`
   builds full graphs via the real exporter (node_limit forced high).
   continuum FULL 9142/27099 dpr1, warm: baseline redraw_min 176 / **p95 997** / load 8608 /
   pan 2.4fps / **longtask_total 12733ms**.
   - v13-hover-arrows 58.9 (**x0.33**), v12-edges-lean 45.2 (x0.26), v02-noarrows 58.4 (x0.33),
     v10-lean 47.9 (x0.27) + load 1123 (**-87%**), v04-straight 103.7 (x0.59).
   - v01-nosim: redraw ~unchanged (x0.97) but load 1167 (-86%); interaction fps got WORSE
     (pan 1.6 vs 2.4) because the spiral leaves a spread layout -> **must bake a good layout, not just disable physics**.
   - Scaling certified: arrow cost grows with edge count; hover-arrows -64% (1.9k) -> -67% (9k).
3. [DONE 2026-10-16] Built `harness/bake.mjs` (stabilize offline -> serialize x/y -> physics off +
   improvedLayout:false) + `harness/probe.mjs` (viewport inspect) + `harness/agg.py` (CSV aggregate).
   rsl bake CLEAN session: load 2437 -> **639/682 (-74%)**, redraw ratio ~1.0 (NOT a redraw lever),
   probe: identical viewport/scale vs baseline, capability intact (arrows 3876, dashed 393, comm 141).
   So bake = a LOAD lever, not an fps leverb. Open: physics-off path showed worse interaction fps and
   new longtasks in some sessions (unexplained) -> do not ship bake alone; pair with arrows-on-hover.
   continuum bake UNMEASURED CLEAN (session was saturated: baseline load 52s vs 8.6s historical).
4. [DONE 2026-10-16] L5 huge-graph prototype. gsoc 104260/292661 -> shipped fallback (community
   aggregate, exporter path via build_base.py --node-limit 5000) = **2290 community nodes / 8045
   cross-community edges**, 2.4 MB, opens (load 2760) but stays LAGGY as shipped: rwmin 177, pan 2.0.
   Shippable levers on it: v13-hover-arrows 65.5 (x0.37), v21-hover-straight 57.8 (x0.33, new variant:
   straight + direction-on-hover, keeps dashes), v19-baked load 736 (x0.27) + rwmin 52.6.
   Unshippable floor v12 (no arrows + no dashes) 33.5 (x0.19) -> the rest is direction/dash removal.
   OPEN L5: pan still ~3fps -> needs viewport edge-culling / progressive edge reveal (no vis option).
5. [DONE 2026-10-16] L6 exporter integration into `graphify/exporters/html.py`:
   - `ARROW_DEFER_EDGE_THRESHOLD = 1500`: graphs above it emit `arrows:{to:{enabled:false}}` plus
     ref-counted hover reveal (`hoverEdge`/`blurEdge`/`hoverNode`/`blurNode`); below it the render is
     byte-identical to before. Direction is shown on hover, never removed.
   - always-on stabilized-layout cache: `_savePositions()` on `stabilizationIterationsDone`,
     `_restorePositions()` applies cached x/y + physics off on re-open. Best-effort (localStorage may throw).
   - CDN `onerror` -> sibling `vis-network.min.js` (offline path; L1 proved the blank-page failure).
   - `tests/test_html_perf_levers.py` (5 tests: gate both sides, direction+dashes survive, cache, offline fallback).
   - evidence: existing suite 113 passed; touched subset 25 passed. Shipped default on rsl, SAME session:
     rwmin 80.5 -> **24.2 (x0.30)**, longtask_total 5487 -> **55** (-99%), zoom 12.0 -> 50.8, load unchanged.
     Reopen probe (`harness/reopen.mjs`): time-to-physics-off **6134ms -> 66ms (-99%)**.
   - build-time bake (independent): rsl load 2437 -> 639 (-74%), gsoc aggregate 2760 -> 736 (-73%).

ALL 5 ITEMS DONE. FINAL-REPORT.md written. Levers certified: deferred arrowheads (redraw),
stabilized-layout cache (load), offline fallback. Remaining open work is in FINAL-REPORT.md
(dense-aggregate pan ~3fps needs viewport culling; first-open still stabilizes; no WebGL renderer).

## Instrument change (important)
`measure.mjs` now drives pan/zoom/hover by ELAPSED TIME (lane `L2t`), not frame count, so cross-variant
fps is comparable. Rows before 2026-10-16 tick3 without lane L2t are frame-driven: only compare fps
WITHIN a variant (redraw_min and load_ms remain valid across all rows).


## Loop
- scheduler: `scheduled-task:7c211c0c-5f9a-4a8b-b32d-c2b2ed54a848`, interval 600000ms,
  bound to this thread. Each tick: read this file, do the next item, update logs, stop on
  exhaustion by writing FINAL-REPORT.md and disabling the task.
- scripts: `harness/sweep.ps1` (run from perf-lab), `harness/chart.py` -> results/chart.html.
- never pipe a sweep into `Select-Object -First`; redirect to a file and tail it.

## Blockers
- gsoc 104k base is 131MB; never fully loaded headful. L5 needs a culling/aggregate prototype.
- Interaction fps confounded by layout; certify with redraw_min + fixed camera.
