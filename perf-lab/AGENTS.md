# perf-lab — agent handoff (READ THIS FIRST)

Everything an agent needs to continue this work without re-deriving it. If you are a
subagent or a fresh session, read this file, then `STATE.md`, then the lane you are working.

**Where this runs:** the lab lives in its own worktree,
`C:\Users\HARIHARAN\.t3\worktrees\Graphify\perf-graph-smoothness`, on branch
`perf/graph-smoothness` (based on `3a09ba73` from `perf/graph-view-lag`). The user's main
checkout, `C:\Users\HARIHARAN\Desktop\Graphify`, is theirs — work here, commit here, and leave
that one alone. The comparison server for the user is
`python -m http.server 8231 --bind 127.0.0.1 --directory .` run from **this** worktree's
`perf-lab`, serving `view/before.html` and `view/after.html`.

## 1. The ask, in the user's words

> "i want the lag to be reduced, the feel of using the graph to be smooth and proper and feel
> like an actual graph which i would love to use."

So the target is **felt** quality: dragging a node, panning, zooming, hovering, reading the
thing. Not a benchmark score. A change that improves a number but makes the graph look or
behave worse is a regression.

## 2. Hard rules (violating one invalidates the work)

1. **Capability is never reduced.** Node count, edge count, communities, direction
   (arrowheads), confidence (dashed edges), and connectivity must all survive. Moving a
   capability to hover or to a zoom threshold is allowed *if the lane doc says so and the
   user-visible default still shows it*; deleting it is not.
2. **Edges are never hidden during a gesture.** `hideEdgesOnDrag` and `hideEdgesOnZoom` are
   banned — the user reported the graph "falling apart" in motion. Smoothness comes from
   drawing them cheaper, never from not drawing them. (Regression test: `tests/test_html_perf_levers.py::test_edges_stay_visible_during_gestures`.)
3. **In motion must look like at rest.** If a lever changes the drawing during a gesture, prove
   the in-motion frame against the resting frame with `harness/probe_motion_pixels.mjs`. The
   current bar is <2% of painted pixels differing; straight-edges-in-motion scored 82-104% and
   was rejected.
4. **No PR, no push.** Local commits on this branch are fine. Never open a PR or push without
   the user saying so in that turn.
5. **Model pin.** Only `opencode/deepseek-v4.1-flash-free` on provider instance `opencode`,
   including every subagent / `delegate_task` target.
6. **Every measurement goes through `harness/bench_lock.py`** (§4). Two agents measuring at
   once silently corrupt each other's numbers.
7. **Never `--use-gl=swiftshader`** for a WebGL measurement, and never treat a single run's
   absolute fps as a result (§4).

## 3. Where things stand (shipped in the exporter, working tree `37da301b`)

`graphify/exporters/html.py` — sha256 `37da301b43ebb7e99490c311bd9e2f7a71b805df3c529695730dcf8ae287d26e`
(uncommitted at the time of writing; the last commit that touched it is `716c421e`).
`graphify/exporters/base.py` — sha256 `1d4bebfc4c868767eed97a8f35b3021e85add9bb712070501ca89166fd5fc242`
(the two community palettes).

| lever | what it does | gate |
|---|---|---|
| arrows on hover | dense graphs stop drawing an arrowhead per edge per frame; hover an edge/node to see direction | >1500 edges (`ARROW_DEFER_EDGE_THRESHOLD`) |
| layout cache | the stabilized x/y are cached so a re-open skips the solver | always |
| pre-baked positions | physics off + no solver + fit when every node carries x/y (consumed since `716c421e`; nothing emits them yet) | all nodes have x/y |
| border lean | for the length of a gesture the disc is drawn at the fill radius (the border that used to grow it is gone, so the lean shrinks the fill instead). A drag measured 33% slower without it | same gate as the lean |
| node disc without the border stroke (L22) | vis draws a node as a fill plus a border stroke of world width `min(nodeWidth, 1.5/scale)`; the border colour is the fill colour, so the same disc is drawn with **one fill** and a size grown by exactly that width. 1886 hairline strokes per frame were the biggest cost of a resting frame (86 ms → 29 ms). Hovered and selected nodes keep a real border, because theirs is white | same gate as the lean |
| batched edge pass | **for the whole session** on dense graphs, `edgeType.drawLine` is replaced per edge by **one draw of every edge**, grouped by (colour, base width); 3876 strokes → 20 on rsl. Dashed (confidence) edges, selected/hovered edges and arrow-bearing edges still go to vis. L12 | same gate as the lean (`_REST_EDGE_BATCH`) |
| curve fidelity | the batch draws the same quadratic vis draws at rest (`_curveTo` reproduces `_getViaCoordinates` for `continuous`), verified against `edgeType.getViaNode()` on all 3876 edges, worst disagreement 0.0 | — |
| eased zoom (L13) | wheel events accumulate a target scale, one redraw per rAF frame, the world point under the cursor held fixed, clamped `fit/6 … min(2.0, fit*12)`; vis's own wheel handler bypassed | same gate as the lean |
| hover focus (L13) | hovered node + 1-hop keep their colour, the rest blend 55% toward `--bg`; written on the node instances (never `nodesDS.update`), restored on blur | same gate as the lean |
| click focus (L24) | the same picture, made sticky: click a node and everything not connected to it dims down until you click away (empty space, the same node, or Escape). The hover focus is suppressed while it is active, so moving the pointer cannot wipe it | same gate as the lean |
| colour-preserving selection (L13) | highlight/hover keep the community fill and add a white border ring; no `#ffffff` fill anywhere | always |
| frame HUD (L13) | fps + frame ms, toggled with `H`, textContent only | same gate as the lean |
| light theme (L25) | the palette, the edge colour, the selection ring and the dimming amount all follow the theme: five of the dark palette's ten colours are below 3:1 contrast on white, and a white selection ring on white is invisible | always |
| adjacency-aware community colours (L27) | the palette is assigned to the communities by a greedy colouring of the community adjacency graph, so two families that share an edge never share a colour (20 of 226 adjacent pairs collided before, 0 now) | always |
| families panel (L28) | every community is a row (colour, name, size), a filter box narrows the list, clicking a name shows that family alone, a colour strip shows one colour's families, and a bulk change is spread over four frames | always |

Certified (`results/ab-rsl-v7-certified.csv`, rsl 1886/3876, interleaved 3 rounds vs a fresh
HEAD build): **node drag 40.4 → 82.9 fps (x2.05), pan 39.1 → 78.9 (x2.02), zoom 15.2 → 80.4
(x5.29)**, stalled frames (>33 ms) 13/14/91 per 90 → 1/1/0. Across all certified runs of this
lever the paired ratio spans **x1.7–x5.8**.

Shipped artifact: `variants/base-ours-v15.html` (2006876 bytes, sha256
`eec347a0dc80328d99151b5b30105bd3fe34d2d2ce92ac71a1a4096ad9fad0e3`). Regenerate it
from the working tree with:
```powershell
python harness/build_base.py --graph-json ../worked/rsl-siege-manager/graph.json --name ours-v15
```
If your regenerated artifact's exporter-block hash differs from the above, the exporter moved:
say so in `LOG.md`, and re-measure before quoting any number in this file.

L22 certified on this artifact (`results/ab-rest-L22-v12.csv`, interleaved 3 rounds,
v10 vs v12): rest p50 84.0 → 27.9 ms (**x0.33**), hover 85.6 → 29.1 ms (**x0.34**), all six
pairs favour the new build. The picture is the same: cross-build pixel diff at a fixed
camera with an identical layout is 3.02% of painted pixels, and it is the anti-aliased edge
of a 1 px dot (0 pixels painted in v10 that v12 does not paint). The white selection ring is
intact (446 white pixels after a real mouse click, v10: 446). L12's at-rest edge parity is
unchanged at 9.83% of painted pixels, colour only.

### Which build is the baseline (this matters more than it looks)

There is no single "current graphify" to compare against. The ladder, oldest to newest:

| build | what it is | viewer script |
|---|---|---|
| `variants/base-official-v8.html` | the **official** repo (`safishamsi/graphify`, remote `origin`), default branch `v8` @ 847a93f3 - the commit it is on today. Its viewer is `graphify/exporters/html.py` and it sets `hideEdgesOnDrag: true`, so the edges vanish while you drag | 340 lines |
| `variants/base-release-main.html` | the official's `main` branch @ 91f4d120, whose viewer still lives in `graphify/export.py` | 164 lines |
| `variants/base-maincheckout.html` | the **user's own checkout**: `perf/graph-view-lag` @ 3a09ba73 - the lean, the batched edge pass, the position cache, the edge-hiding fix | 616 lines |
| `variants/base-ours-v15.html` | this session's work (v12 + the light theme, the adjacency-aware community colours and the families panel) | 884 lines |

`view/before.html` is the **official** build (what an install of graphify renders today),
`view/before-your-checkout.html` is the user's checkout, `view/after.html` is the current
build. The official `main` branch is *older* than its own `v8` branch, and the `v1.0.0` tag
is from 2026-04-05, so "the latest official" is `origin/v8` @ 847a93f3.

Against the official, 5 interleaved rounds on the **shipped** build
(`results/ab-rsl-official-v15.csv`): node drag 15.1 → 35.3 fps (x2.34, jank 89 → 24), pan
15.4 → 36.1 (x2.34, jank 89 → 17), zoom 6.4 → 35.5 (x5.55, jank 91 → 21). Rest and hover,
3 rounds (`results/ab-rest-official-v15.csv`): rest 184.1 → 29.1 ms (x0.16), hover
183.7 → 29.9 ms (x0.16). The earlier certification of the same levers on v11 is in
`results/ab-rsl-official-v12.csv` (x2.34 / x2.44 / x5.42).

Against the user's own checkout, 5 interleaved rounds (`results/ab-rsl-checkout-v12-5r.csv`):
node drag 38.3 → 36.9 fps (x0.96, jank 20 → 16), pan 30.8 → 37.2 fps (x1.21, jank 38 → 19),
and 3 rounds for zoom (`results/ab-rsl-checkout-v12.csv`): 32.0 → 34.2 fps (x1.07, jank
40 → 29).

**L14 certified on this artifact: an idle page draws nothing and wakes up nothing (0 draws,
0 rAF in 3 s; before the fix 432 rAF wake-ups, because the frame HUD's loop ran for the
life of the page).

**L25/L27/L28 certified on this artifact:**
- the light theme has its own palette (0 of 10 community colours below 3:1 on white, was 5),
  its own edge colour and opacity, its own selection ring and its own dimming amount;
- the community colours are adjacency-aware: **0 of the 226 adjacent community pairs share
  a colour** (20 before), measured on the shipped builds with `harness/l27_collisions.py`;
- the families panel lists all 141 families with a filter box, an isolate action and a
  colour strip; a bulk change is spread over four frames (worst frame 76 ms instead of one
  280 ms block), and "show all" is free when nothing is hidden.

L24 certified on this artifact (`harness/probe_click_focus.mjs`): clicking a node leaves
38 nodes bright (the node + its 37 neighbours) and dims the other 1848; empty space, the
same node again, and Escape each restore 1886 / 0. The click focus paints only on a click,
through the same mechanism as the hover focus, and the A/A control
(`results/ab-rest-AA-control.csv`, the same build measured against itself) shows the
harness's own position bias is x1.58 on the resting frame - larger than any difference the
click focus could produce.

**The open is faster because of the layout cache** (`harness/probe_reopen.mjs`, three opens
in one browser context): ours 4538 ms first open -> **363 ms** re-open (the stabilized
positions are kept in localStorage, so vis's solver is skipped); the official build
4848 ms -> 4416 ms, because it runs the solver on every open. The *first* open in a fresh
browser still pays the solver - that is the `--bake` lever.

L12 (edge batch at rest) on v9 (`results/ab-rest-L12.csv`, interleaved 3 rounds, v8 vs v9):
rest p50 85.0 → 79.9 ms (x0.94), hover 88.0 → 73.8 ms (x0.84), all six pairs favour v9. At-rest
parity **10.22% of painted pixels differ, colour only** — the batch changes which translucent
edge is on top at a crossing (coverage equal to ±4 px of 143 k; the nodash control, same order
both sides, is 1.61%). Capability probe on v9: arrow 103 px, selection 172 px → 0 on deselect,
legend toggle matches vis (edges of hidden nodes are skipped via both-endpoints-visible, which
is vis's own rule). Flip `_REST_EDGE_BATCH = false` for pixel-identical rest.

L13 certified on this artifact (`results/L13-zoomhealth-v8.txt`): zoom in p50 16.9 / p95 29.1
/ max 105.7 ms, 3 stalls >33 ms per 98 frames, 0 >250 ms; zoom out p50 21.8 / p95 30.8. Lean
true and the edge batch on all 3876 edges mid-zoom, `white: 0`, `dimmed: 0`; hover dims 1884
and restores to 0 on blur. First open (5-round medians, `results/ab-load-L13.csv`): it200 9907
ms, it60 5030, it30 1901 (rejected on layout quality), nolayout 9547, baked 1259.

## 4. The measurement contract

**The host drifts ~3x between batches.** The *same* shipped file measured 15.0 fps in round 1
and 43.7 fps in round 2 of one run. Consequences:

- Sequential before/then/after is **invalid** and has already produced one false finding.
- Use `harness/ab_drag.mjs`, which interleaves all variants inside every round and is
  variable-order. Paired ratios are the durable output; absolute fps is not.
- Use an **odd** number of rounds. A median-of-two silently reports the upper of two rounds.
- Report stalls (`jank > 33ms` per 90 frames) next to fps. Stalls are what the user feels.

Every measured run must hold the bench lock:
```powershell
python harness/bench_lock.py status
python harness/bench_lock.py run --why "why I am measuring" -- node harness/ab_drag.mjs ...
```
`run` holds the lock for the child's lifetime, releases, and appends to
`results/bench-runs.log` (the audit trail). A lock is stolen after 20 minutes; `--force`
steals immediately. Do not measure outside `run`.

Canonical commands:
```powershell
# interleaved A/B/C (the primary instrument)
node harness/ab_drag.mjs --variants "before=variants/base-rsl-head.html,curved=variants/base-ours-v8.html" `
     --rounds 3 --gestures node,pan,zoom --steps 90 --graph rsl --out results/ab-rsl-<what>.csv

# where do the canvas ops go? (stroke counts, lineWidth histograms, bezier/line/quad counters)
node harness/probe_borderdraw.mjs --file variants/base-ours-v8.html --mode node|pan|zoom
# is the batched draw faithful? (stroke count, curve count, colour/dash sets, live endpoints, restore)
node harness/probe_edgebatch.mjs --file variants/base-ours-v8.html
# does the in-motion frame match the resting frame? (pixel diff at the same camera)
python harness/mk_batch_curved.py   # builds the "noborder" builds the pixel probe needs
node harness/probe_motion_pixels.mjs --file variants/batch-curved-noborder.html --mode pan|zoom
# what does it look like mid-gesture?
node harness/shot_gesture.mjs --file variants/base-ours-v8.html --mode pan --out shots/x.png
# render the user-facing pair, then serve it
python harness/make_view.py
python -m http.server 8231 --bind 127.0.0.1 --directory .    # from perf-lab
node harness/smoke_view.mjs --file view/after.html           # counts + console errors + real drag
# docs/plots + regression tests
python harness/chart.py
python -m pytest tests/test_html_perf_levers.py -q           # from the repo root
```

Graph ladder (build any of them with `harness/build_base.py --graph-json <json> --name <n>`):
| name | source | nodes/edges | use |
|---|---|---|---|
| rsl | `worked/rsl-siege-manager/graph.json` | 1886/3876, 141 communities | **primary**, every claim is on this |
| httpx | `worked/httpx/graph.json` | 144/330 | small-graph "must be byte-identical" checks |
| karpathy-repos | `worked/karpathy-repos/graph.json` | ~177 | sparse control |
| gsoc (aggregate) | see `LOG.md` | 2290/8045 | mid-size scaling |
| continuum | see `LOG.md` | 9142/27099 | beyond the shippable ceiling (engine aggregates here) |
| gsoc (full) | see `LOG.md` | 104260/292661 | stress only |

## 5. Evidence registry — where a finding has to land

| file | what belongs there | rule |
|---|---|---|
| `STATE.md` | phase, numbered task list with DONE/NEXT/PARKED, **tick status** | rewrite the tick status each tick; append tasks, never renumber history |
| `LOG.md` | chronological one-liners: what was tried, what it measured, what was rejected | append only, newest last, date-prefixed |
| `DECISIONS.tsv` | `D<n> \t date \t decision \t why \t evidence \t status` | one row per decision, append only, never edit an old row |
| `lanes/L<n>-*.md` | the lane's brief, hypothesis, method, tables, screenshots, verdict | the lane doc is the artifact; a lane is not done until it is written |
| `results/*.csv` | raw interleaved A/B output | never hand-edit; the CSV is the source of truth for a number quoted elsewhere |
| `results/bench-runs.log` | automatic audit trail of every locked run | written by `bench_lock.py`, do not hand-edit |
| `shots/*.png` | visual evidence, especially mid-gesture | name them after the build they came from |

A measurement that is not in a CSV and a finding that is not in a lane doc + `DECISIONS.tsv`
does not exist for the next agent.

## 6. Lane board

Done: **L1** offline/CDN, **L2** load+physics, **L3** edge render, **L4** labels/LOD,
**L5** huge graphs, **L6** exporter integration, **L8** gesture latency, **L9** node draw
(no lever), **L10** pre-baked positions (consumed, `--bake` flag outstanding),
**L11** viewer experience (folded into the exporter as `_UX_JS` by L13),
**L12** edge batch at rest (shipped; x0.94 rest / x0.84 hover, colour-only ordering diff),
**L13** interaction feel (eased zoom, hover focus, colour-preserving selection),
**L14** quiet page (the HUD's rAF loop only runs while the HUD is on: 432 → 0 wake-ups),
**L17** first open (fewer iterations ruin the layout; the open can only get faster by
moving the layout offline),
**L22** node disc without the border stroke (shipped; rest x0.24, hover x0.25),
**L24** click to focus (shipped; the user asked for it by name),
**L25** light theme (shipped; its own palette, edges, ring and dimming - 5 of 10 colours were
below 3:1 contrast on white),
**L26** sleekness remainder (findings only: the rest frame is now the edge raster, the focus
paint is cheap, "show all" was a 150 ms freeze - fixed by L28),
**L27** layout quality + adjacency-aware community colours (shipped; 20 of 226 adjacent
community pairs shared a colour, now 0),
**L28** families panel (shipped; family rows, filter box, isolate, colour strip).
Parked: **L7** WebGL/sigma (numbers were great — pan 4.8 → 90-110 fps — but the user rejected
the look and it needs a full rewrite). Do not reopen L7 unless the user asks.

Open, in the order they are worth trying. Take one, write `lanes/L<n>-<name>.md`, and put your
hypothesis in it *before* you measure.

- **L10 follow-up — the `--bake` flag.** First open is still ~9.9 s on rsl because the solver
  runs; baking positions measured 1.3 s (x0.13) with the 200-iteration layout intact
  (`results/ab-load-L13.csv`). The exporter already consumes x/y; what is missing is a
  headless-browser step at export time that writes them into the node data.
- **L5 (revisit) — beyond canvas 2D.** 9142-node graphs are unusable at any setting. Aggregate
  view exists; the honest alternatives are a bundled/edge-summarised low-zoom view (capability
  returns on zoom-in) or WebGL (rejected).

## 7. A tick (what the 30-minute loop does)

1. `python harness/bench_lock.py status` — if another agent holds it, do the unmeasured work
   (docs, code, harness) and stop; do not measure without the lock.
2. Read `STATE.md` tick status → take the next unfinished item.
3. Do it in a scratch variant (never edit the exporter first).
4. Measure it interleaved, 3+ rounds, through the bench lock.
5. Prove parity (`probe_motion_pixels.mjs`) if the drawing changes in motion.
6. Only then port the winner into `graphify/exporters/html.py`, add/adjust a test in
   `tests/test_html_perf_levers.py`, and rebuild `variants/base-ours-v<next>.html`.
7. Rebuild `view/after.html` (`make_view.py`), smoke test it, re-run `chart.py`.
8. Log: lane doc tables, `DECISIONS.tsv` row, `LOG.md` lines, `STATE.md` tick status.
9. Commit locally (`perf/graph-smoothness`). Never push.

## 8. Definition of done for a lever

- [ ] hypothesis written in the lane doc before measuring
- [ ] interleaved A/B/C, ≥3 rounds, through the bench lock, CSV in `results/`
- [ ] stalls and paired ratio reported, not a bare fps
- [ ] capability intact (nodes, edges, communities, direction, confidence, connectivity)
- [ ] look-parity proven if the drawing changes in motion
- [ ] regression test in `tests/test_html_perf_levers.py`, whole file green
- [ ] `view/before.html` + `view/after.html` rebuilt and smoke-tested
- [ ] `DECISIONS.tsv` + `LOG.md` + lane doc + `STATE.md` tick status updated
- [ ] local commit

## 9. Traps already paid for (do not pay again)

- `network.setOptions({nodes:{borderWidth}})` costs a full synchronous redraw (~80 ms rsl,
  ~200 ms 2290-node, 670-2000 ms at 9142) — write to the instances instead.
- Writing `edge.options.smooth`/`width` mid-gesture does nothing: vis resolves the draw from
  the instance options *during* the draw and caches the curve class in `updateEdgeType()`
  (mid-gesture all 3876 edges reported `smooth:false, width:1` while the canvas emitted 0
  `lineTo` and stroked at lineWidth 3.63).
- Edge `lineWidth` must be re-derived per frame as `max(baseWidth, 0.3/scale)`; the floor moves
  with the zoom.
- `setLineDash` restarts at every `moveTo`, so grouping dashed edges does **not** shift the
  dash phase. The 10% at-rest pixel diff of the edge batch is stroke *order*: at a crossing the
  top-most translucent edge wins, and colour grouping changes who wins. Geometry/width/colour
  are exact (nodash control: 1.61%, which is only overlap). Do not chase the dash theory again.
- **The node border is the frame.** vis draws a node as a fill plus a border stroke of world
  width `min(nodeWidth, 1.5/scale)` - at the fit scale the stroke is as wide as the node, so
  the node you see is a disc twice its fill radius, and 1886 hairline strokes per frame cost
  ~57 ms of an 86 ms frame. The border colour is the fill colour, so the disc can be drawn
  with one fill and a size grown by `min(size, 1.5/scale)`. Hovered/selected nodes keep a real
  border, because theirs is white.
- A node's *drawn* size and the *layout* size are different things: change the size only
  after the solver has run, or the layout changes with it.
- `getImageData(0,0,1,1)` does not force a full rasterization - a canvas replay that
  "costs 2 ms" may have rasterized nothing. Read back the whole canvas, or draw on the
  visible canvas and let the frame present.
- vis skips an edge when the edge **or either endpoint node** is hidden
  (`Body._updateVisibleIndices`), and `edge.getFormattingValues().hidden` does not reflect a
  hidden endpoint. A cached batch must check `e.from.options.hidden || e.to.options.hidden`
  or a legend toggle leaves orphan edges painted (364 of them on rsl).
- A fresh page's first two idle frames differ from the settled frame by ~40 k px (one delayed
  pass on the 3rd draw, camera unchanged). Any pixel probe must settle past it, and a probe
  that compares "immediately after an option flip" can understate a diff by measuring a frame
  that has not been redrawn yet - give each side ~350 ms and a real redraw.
- A synthetic `network.emit('hoverNode')` does **not** set the node's hovered state, and
  `network.setSelection()` does **not** fire `selectNode`. To see what a click really draws,
  click with the real mouse (`page.mouse.click` at the node's screen position).
- vis does not redraw on pointer-up (0 canvas strokes in the 20 frames after release), so a
  restore needs an explicit redraw.
- Padding/viewport size changes the on-screen content, so `pan_fps`-style numbers are only
  comparable within one layout.
- `n.options.opacity` and `setOptions({ nodes: { opacity } })` do **not** change the draw;
  only `n.options.color.background` / `.border` does. Writing those on the instances is cheap;
  `nodesDS.update` for 1886 nodes is 149.6 ms.
- vis emits no `hoverNode` from Playwright's synthetic mouse in headless Chrome (the move
  arrives — its tooltip shows the node label — and the HEAD baseline behaves identically).
  Drive `network.emit('hoverNode')` when a probe needs the hover code to run, and say so.
- A Python string that ends up in the emitted page must not contain `\\n`: `716c421e` shipped
  the stabilization handler that way and every build since had a parse error and rendered
  nothing (caught by `smoke_view.mjs` as `Invalid or unexpected token`). Keep injected JS on
  one line, and let `test_stabilization_handler_is_valid_js` guard it.
- `worked/` JSONs and root-level `dbg_*.py` / `fuzz_*.py` / `cov_*.py` / `repro_*.py` are the
  user's scratch files. Do not delete or "tidy" them.

## 10. New-agent checklist (first 10 minutes)

1. Read this file, `STATE.md` tick status, the last 20 lines of `LOG.md`, the tail of `DECISIONS.tsv`.
2. `python harness/bench_lock.py status`.
3. Confirm the shipped artifact is current: rebuild `base-ours-v15.html` and compare the
   exporter block against the hash above.
4. `python -m pytest tests/test_html_perf_levers.py -q` (from the repo root) - 44 tests, all
   green, before you change anything.
5. Pick a lane from §6 or the next `STATE.md` item, write the lane doc, then measure.
