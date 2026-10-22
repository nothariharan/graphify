# L25 — the layout: is the hairball the solver, the canvas, the colours, or the labels?

Status: **hypotheses written before measuring.** Measurements appended below as they land.

## The complaint this lane answers

> "the user likes the graph but the layout is a hairball"

1 886 nodes, 3 876 edges, 141 communities, laid out by vis's `forceAtlas2Based` solver
(`gravitationalConstant -60, centralGravity 0.005, springLength 120, springConstant 0.08,
damping 0.4, avoidOverlap 0.8`, 200 stabilization iterations, seed = golden-angle spiral).
That solver is 6.3 s of the 9.9 s first open (L17). L17 proved the open can only get much
faster by moving the layout offline; it did not ask whether the *picture* is any good, or
what would make it better.

This lane is **quality, not fps**. Every number here is a property of the point cloud, the
colour assignment or the label gate, measured on the positions vis actually produced.

## Hypotheses (written before the first measurement)

**H1 — the ball is isotropic and the canvas is not.** A force layout has no preferred axis,
so the bbox aspect of the point cloud will be within ~15% of 1.0. On the exporter's canvas
(1280 viewport − 280 px sidebar ≈ 1000 × 800) `network.fit` is bound by the *height*, so a
1.0-aspect ball paints ~800 px of a 1000 px width: ~20% of the canvas is empty margin on
each side, and the fit scale is set by the height regardless of the width. Prediction: the
graph reads as a round blob floating in a wide frame, and **making the layout wider is
cosmetic** — an x-stretch does not change the number of crossings (affine invariance), does
not change the on-screen node spacing (fit is height-bound), and only fills the side margins.

**H2 — the metric that actually decides legibility is the spread ratio**, not crossings.
`spread = median edge length / sqrt(bbox area)` is scale-free and survives `fit`. After fit,
median edge px = `spread × 800`, and the node dot px diameter = `size × fit`. If the median
edge is ~10 px and the dots are ~2 px, the hairball is a consequence of *1 886 dots inside an
800 px square*, and no solver change fixes that — only fewer nodes on screen (zoom / focus)
or less area-per-node does.

**H3 — community colour is `cid % 10`, so it carries no meaning.** With 141 communities and a
10-colour palette, ~14 communities share every colour; two communities with ids 3 and 103 are
painted identically. Prediction: a large fraction of *spatially adjacent* community pairs
(they share inter-community edges) are the same colour, so the eye reads them as one cluster.
Measured as "adjacent-community colour collisions". A size-ordered or adjacency-aware
assignment should cut that substantially at zero render cost.

**H4 — the label gate is a degree gate with no zoom gate.** `font_size = 12 if deg >=
0.15·max_deg else 0`, so 66 nodes carry a label at *every* zoom. vis multiplies font size by
the view scale, so at the fit scale (~0.08) a 12 px label is drawn at ~1 px: 66 smears, not
66 labels. Prediction: labels cannot be read at the fit view at all, they pop only past
scale ≈ 0.6 (where a small fraction of the graph is on screen), and they overlap each other
long before that.

**H5 — a numpy forceAtlas2 can bake the same picture without a browser.** numpy is already a
hard dependency of graphify. If a FA2 implementation in Python at 200 iterations reaches
crossings / separation / spread within ~25% of the browser's, then `--bake` can be a pure
Python export step (no Node, no Chrome), which is the packaging blocker L17 left open.
Prediction: the same force model in numpy reproduces the *character* of the layout
(communities apart, intra edges shorter than inter) but not the exact numbers; the honest
question is whether it is worse than the browser's by more than it is worth.

**H6 — the current layout is not "bad solvers", it is "no explicit structure".** If H1–H3
hold, the ranked levers are: (1) colour assignment (free, no geometry change), (2) label LOD
gate (free), (3) bake the layout in Python (removes the open cost), (4) a *structured* seed
(community-packed) only if the metrics show the force layout fails to separate communities.

## Method

- `harness/probe_layout.mjs` — the lab's existing layout instrument (edge lengths,
  intra/inter ratio, community separation, exact crossings, short edges). Baseline rows.
- `harness/l25_dump.mjs` (new) — opens an artifact in a fresh context, waits for
  `physics.enabled === false`, and dumps the stabilized positions plus per-node
  (community, degree, size, font, label) and the edge list to JSON, along with the real
  canvas size and the fit scale. Everything below is computed from one dump so the numbers
  are mutually consistent.
- `harness/l25_metrics.py` (new) — the shared metrics kernel. Runs on a dump from *either*
  the browser or the numpy layout, so the two are compared by the same code: bbox/aspect,
  spread, edge-length distribution, intra/inter, separation, exact crossings (numpy,
  shared-endpoint pairs excluded), short edges, nearest-neighbour distance in px at the real
  fit scale, node-dot px, label counts / overlaps / legibility scale, and the colour audit.
- `harness/l25_layout_np.py` (new) — numpy `forceAtlas2Based` prototype: same constants as
  the exporter, same golden-angle seed, Barnes–Hut-free O(n²) repulsion, 200 iterations.
  Timed. Its output is dumped in the same JSON shape and scored by the same kernel.
- `harness/l25_grid.py` (new) — the hypothetical assignments that need no browser:
  aspect stretch (x1.25), and a community-grid / adjacency-aware colouring, scored with the
  same numbers so the recommendation is not a hunch.
- Bench lock: every measurement that touches the browser goes through
  `python harness/bench_lock.py run --why "..."`. Pure-numpy scoring runs are CPU work on
  the same host and are locked too when they are being timed for a quoted number.

## Results

(filled in below, in measurement order)
