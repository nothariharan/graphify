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

## 3. Where things stand (shipped in the exporter, working tree `b17c3797`)

`graphify/exporters/html.py` — sha256 `b17c3797bae7ab88f1761acd6a2c585b4d979b9f77dd7afe25cd061abe52ac9e`
(uncommitted at the time of writing; the last commit that touched it is `716c421e`).

| lever | what it does | gate |
|---|---|---|
| arrows on hover | dense graphs stop drawing an arrowhead per edge per frame; hover an edge/node to see direction | >1500 edges (`ARROW_DEFER_EDGE_THRESHOLD`) |
| layout cache | the stabilized x/y are cached so a re-open skips the solver | always |
| pre-baked positions | physics off + no solver + fit when every node carries x/y (consumed since `716c421e`; nothing emits them yet) | all nodes have x/y |
| border lean | during a drag/zoom the node border stroke is dropped and restored on release | >800 nodes (`LEAN_GESTURE_NODE_THRESHOLD`) |
| batched edge pass | for the length of a gesture, `edgeType.drawLine` is replaced per edge by **one draw of every edge**, grouped by (colour, dashes, base width); 3876 strokes → 20 on rsl | same gate as the lean |
| curve fidelity | the batch draws the same quadratic vis draws at rest (`_curveTo` reproduces `_getViaCoordinates` for `continuous`), verified against `edgeType.getViaNode()` on all 3876 edges, worst disagreement 0.0 | — |
| eased zoom (L13) | wheel events accumulate a target scale, one redraw per rAF frame, the world point under the cursor held fixed, clamped `fit/6 … min(2.0, fit*12)`; vis's own wheel handler bypassed | same gate as the lean |
| hover focus (L13) | hovered node + 1-hop keep their colour, the rest blend 55% toward `--bg`; written on the node instances (never `nodesDS.update`), restored on blur | same gate as the lean |
| colour-preserving selection (L13) | highlight/hover keep the community fill and add a white border ring; no `#ffffff` fill anywhere | always |
| frame HUD (L13) | fps + frame ms, toggled with `H`, textContent only | same gate as the lean |

Certified (`results/ab-rsl-v7-certified.csv`, rsl 1886/3876, interleaved 3 rounds vs a fresh
HEAD build): **node drag 40.4 → 82.9 fps (x2.05), pan 39.1 → 78.9 (x2.02), zoom 15.2 → 80.4
(x5.29)**, stalled frames (>33 ms) 13/14/91 per 90 → 1/1/0. Across all certified runs of this
lever the paired ratio spans **x1.7–x5.8**.

Shipped artifact: `variants/base-ours-v8.html` (1972184 bytes, sha256
`c09d310fb6036da7d2a3e5c230c4e72eefaf6c284ed4f0f33299111f41b357c8`). Regenerate it
from the working tree with:
```powershell
python harness/build_base.py --graph-json ../worked/rsl-siege-manager/graph.json --name ours-v8
```
If your regenerated artifact's exporter-block hash differs from the above, the exporter moved:
say so in `LOG.md`, and re-measure before quoting any number in this file.

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
**L13** interaction feel (eased zoom, hover focus, colour-preserving selection).
Parked: **L7** WebGL/sigma (numbers were great — pan 4.8 → 90-110 fps — but the user rejected
the look and it needs a full rewrite). Do not reopen L7 unless the user asks.

Open, in the order they are worth trying. Take one, write `lanes/L<n>-<name>.md`, and put your
hypothesis in it *before* you measure.

- **L10 follow-up — the `--bake` flag.** First open is still ~9.9 s on rsl because the solver
  runs; baking positions measured 1.3 s (x0.13) with the 200-iteration layout intact
  (`results/ab-load-L13.csv`). The exporter already consumes x/y; what is missing is a
  headless-browser step at export time that writes them into the node data.
- **L12 — keep the edge batch on at rest.** The resting frame is 5762 strokes; the batch draws
  the same curves in 20. Closed L9 proposed it; nobody has measured it yet.
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
- `setLineDash` is per-path, not per-subpath, so grouping dashed edges shifts their dash phase
  (this is the residual 1-2% in the pixel diff). Still dashes, still the same colour.
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
3. Confirm the shipped artifact is current: rebuild `base-ours-v8.html` and compare the
   exporter block against the hash above.
4. `python -m pytest tests/test_html_perf_levers.py -q` (from the repo root) — 27 tests, all
   green, before you change anything.
5. Pick a lane from §6 or the next `STATE.md` item, write the lane doc, then measure.
