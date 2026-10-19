# Lane L2 — on-load physics / baked layout

Owner: subagent (deepseek-v4.1-flash-free). Primary metric: load_ms; secondary redraw_min.

## Brief
`physics.enabled:true` + `stabilization:{iterations:200, fit:true}` runs on every open
(html.py L191-203), disabled only at `stabilizationIterationsDone` (L252-254).
Measured: disabling it drops rsl load 3020 -> 368ms (-88%).
Capability at stake: layout quality/positions. If we bake a stabilized layout into the
node data (x/y) and open with physics off, the picture is identical and the cost moves
offline. This is the capability-preserving form of the win.

## Steps
1. Produce a "baked" base: stabilize once (headless), serialize x/y into RAW_NODES,
   open with physics:false + improvedLayout:false. Measure load/redraw vs baseline.
2. Confirm positions visually match baseline (spot-check overlay / node ordering).
3. Decide where baking happens in the exporter (build-time) vs first open (persist localStorage).

## Status
BAKE BUILT + MEASURED; SHIPPED IN A DIFFERENT FORM (2026-10-16).
- `harness/bake.mjs` (build-time stabilize -> serialize x/y -> physics off + improvedLayout:false):
  rsl clean load **2437 -> 639 (-74%)**; viewport identical to baseline (probe scale 0.083,
  view(-5,154)); capability intact (arrows 3876, dashed 393, communities 141). redraw ratio ~1.0
  -> bake is a LOAD lever, not a redraw lever. gsoc aggregate: load 2760 -> 736 (-73%).
- SHIPPED variant of the same idea: an always-on stabilized-layout cache in the exporter
  (localStorage save on `stabilizationIterationsDone`, restore on re-open). No x/y blob in the
  file, no Python layout cost, and it removes the cost for every graph the user re-opens:
  reopen probe 6134ms -> 66ms to physics-off (-99%).
- Open: first open still stabilizes (rsl ~2.4s, continuum ~8.6s). Moving that offline needs the
  build-time bake, which was not shipped.
