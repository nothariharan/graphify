# L10 — instant first open (bake the layout at export)

## Hypothesis

The first open of an exported `graph.html` still runs the vis solver (~2.4s on rsl,
~8.6s on continuum); only the *second* open is instant, via the localStorage cache
(L2, shipped). Moving that cost offline needs the build-time bake (`harness/bake.mjs`,
which stabilizes once in headless Chrome and serializes x/y), but that bake was never
wired into the real exporter — so every `graphify` export ships a graph that has to
re-solve on first open. The lever: have `to_html` consume pre-baked positions when the
input graph carries them, opening with physics off and the cache as the fallback.

## What changed in the exporter

`graphify/exporters/html.py` (`to_html` + `_html_script`):

- Node dict now copies `x`/`y` from the input node data when present
  (`if data.get("x") is not None and data.get("y") is not None`).
- `nodesDS` uses `n.x`/`n.y` when present, else the existing Fermat/golden-angle
  spiral seed (so un-baked graphs are byte-identical to before).
- When **every** node carries positions, physics is emitted `enabled: false` with
  `stabilization.iterations: 0`, the `stabilizationIterationsDone` handler (which
  re-enables nothing and just saves positions) is skipped, and a
  `network.fit({ animation: false })` is emitted so the view is framed without a solver.
- The localStorage cache (`_POSITION_CACHE_JS`) is still emitted and still applies as
  the fallback for re-opens, so a baked graph that is re-opened behaves exactly like
  before (cached positions override baked ones when present and graph-specific).

Capability is untouched: nodes, edges, communities, direction, confidence/dashes,
connectivity, labels, search, legend, hyperedges all survive. Only the on-load
stabilization is removed when positions are present.

## Evidence

- L2 (already measured, `perf-lab/lanes/L2-load-physics.md`): bake.mjs on rsl
  measured clean load **2437 -> 639 ms (-74%)** and the viewport is identical to
  baseline (probe scale 0.083, view(-5,154)); gsoc aggregate **2760 -> 736 (-73%)**.
  Capability intact (arrows 3876, dashed 393, communities 141). redraw ratio ~1.0 —
  bake is a LOAD lever, not a redraw lever.
- Reopen probe (L2): **6134 ms -> 66 ms to physics-off (-99%)** for a re-open.
- Exporter wiring verified by `_l10test.py` / `_l10test2.py` in this worktree:
  - graph WITH x/y: `RAW_NODES` carries `x`/`y`, `physics.enabled: false`,
    no `stabilizationIterationsDone` handler, `network.fit` emitted.
  - graph WITHOUT x/y: `physics.enabled: true`, handler present, spiral seed used
    (byte-identical path to the pre-change behaviour).
- `tests/test_html_perf_levers.py` still 20/20 green (with `PYTHONPATH` set to the
  worktree).

## File-size impact

Positions add ~2 floats per node (~12-16 bytes JSON each after escaping), i.e. roughly
25-30 KB on rsl (1886 nodes). Negligible next to the ~1.8 MB artifact.

## How a baked graph is produced

The exporter only *consumes* positions; something has to *produce* them. Two routes:

1. **`harness/bake.mjs`** (already shipped, vis-faithful): run it on a generated
   `graph.html` to produce a baked copy. It stabilizes with vis's own
   `forceAtlas2Based` solver (200 iterations, fit:true) so the layout is identical
   to what vis would produce, then serializes x/y and turns physics off.
   `node harness/bake.mjs --file variants/base-rsl.html --out variants/rsl-baked.html`
2. **A future `--bake` flag on `graphify export html`** that runs the bake as a
   post-step (Node subprocess) and overwrites `graph.html`. Not wired in this tick —
   it adds a Node dependency to the core export path and needs path resolution for
   the installed package. Proposed as the follow-up so first opens become instant
   without a manual step.

Until (2) lands, a graph without positions behaves exactly as before (solver on
first open, cache on re-open), so this change is purely additive and cannot regress
an existing export.

## Verdict

Adopt the exporter wiring (additive, capability-preserving, verified). The -74% load
win is already measured in L2; this lane's contribution is making the exporter able
to *use* it. The remaining piece (populating positions automatically) is the `--bake`
flag, tracked as the follow-up.

## Regression test

Proposed (not added, to keep the change minimal and because the bake needs a browser):
a test that renders a graph whose nodes carry `x`/`y` and asserts
`physics.enabled: false`, the positions survive into `RAW_NODES`, and the spiral seed
is not used; plus the existing 20 tests still pass on the un-baked path. The existing
`test_html_perf_levers.py` covers the perf levers; the baked path is covered by the
`_l10test.py` / `_l10test2.py` scratch probes in `perf-lab/harness/`.