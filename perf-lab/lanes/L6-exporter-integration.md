# Lane L6 — exporter integration + regression

Owner: subagent (deepseek-v4.1-flash-free) after L2/L3 certify. Primary metric: same
battery on the real exported artifact; plus a regression guard.

## Brief
Apply the certified levers in `graphify/exporters/html.py` with no capability loss:
- L3: arrows default off, on for hovered/selected edges (L186 + hover handlers ~L348).
- L2: bake stabilized x/y into node data; open physics:false (L191-203, L252-254).
- L1: local/offline vis-network delivery (L733).
Keep node/edge/community counts, dash confidence cue, and connectivity exactly as-is.

## Steps
1. New branch (already: perf/graph-view-lag). Edit html.py; regenerate an artifact from a
   real `graph.json`; run the battery on the real artifact and diff vs baseline row.
2. Add a cheap regression test: exported HTML contains the new defaults; or a size/load
   assertion on a fixture.
3. `graphify update .` after code changes (repo rule). No PR unless asked.

## Status
DONE (2026-10-16). Shipped in `graphify/exporters/html.py`:
- L3 deferred arrowheads, gated at `ARROW_DEFER_EDGE_THRESHOLD = 1500` edges; ref-counted
  hover reveal (edge hover, and node hover for all incident edges). Below the gate the
  emitted render is byte-identical to before.
- L2 stabilized-layout cache (localStorage): `_savePositions()` after stabilization,
  `_restorePositions()` on re-open applies cached x/y + physics off. Chosen over a build-time
  x/y blob: no vendored positions, no Python layout cost, same -73%..-99% load win.
- L1 CDN `onerror` -> sibling `vis-network.min.js`.
- `tests/test_html_perf_levers.py` (5 tests). Existing suite 113 passed.
Measured on the real artifact (rsl, same session): rwmin 80.5 -> 24.2 (x0.30),
longtask_total 5487 -> 55, zoom 12.0 -> 50.8, load ~unchanged. Re-open 6134ms -> 66ms.
Not committed; no PR. `graphify update .` not run (no user confirmation requested yet).
