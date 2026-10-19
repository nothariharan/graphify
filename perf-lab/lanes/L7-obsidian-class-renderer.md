# Lane L7 — Obsidian-class renderer (replace vis-network canvas with WebGL)

Owner: subagent (deepseek-v4.1-flash-free). Primary metric: **pan/zoom fps on the
felt metric** (a user sees nothing below ~30fps), then load_ms, then redraw.

## Why this lane exists
The user tested before/after on rsl and reported **no notable difference**. That is
correct and expected: the L2/L3 levers cut redraw 80ms -> 24ms, but the same battery
shows pan going only ~5fps -> ~10fps. **Both are below the smoothness threshold**, so
the change is invisible to a human. Frame-cost reduction is not the same as felt
smoothness. Reaching Obsidian-like feel needs a different renderer, not more patches
to the canvas one.

## Why vis-network cannot get there
vis-network 9.1.6/10.x is canvas-2D only (no WebGL flag). Every node and every edge
(plus arrowheads/curves) is a per-frame 2D path. dpr2 gave only +2% redraw, i.e. the
cost is CPU geometry, not fill - so it cannot be bought back with a GPU that is idle.

## Library scan (2026-10-16, `results/lib-scan.txt`)
WebGL / GPU capable:
- **sigma.js 4.0.3** - 12,191 stars, MIT, pushed 2026-10-16, 474k weekly downloads.
  Purpose-built "thousands of nodes and edges", WebGL renderer, pairs with graphology.
- **@cosmograph/cosmos 3.4.1** - "GPU-based force graph layout and rendering", 7k weekly.
- **@antv/g6 5.1.1** - 12,335 stars, MIT, canvas + WebGL renderer.
- **pixi.js 8.22.0** - 48,403 stars, the 2D WebGL engine Obsidian's own graph is built
  on. Highest control, highest effort (we would write the graph view ourselves).
Not WebGL (canvas): cytoscape 3.34.4, force-graph, 3d-force-graph (three.js, 3D),
vis-network (current), echarts.

Obsidian-ecosystem pattern (github search) confirms the direction: the community graph
plugins are all 3D/WebGL (obsidian-jarvis-ui, ReverySky, advanced_graph_view, akasha,
solar-graph).

## Decision
Prototype **sigma.js + graphology** first. It is the lowest-effort path to a genuine
WebGL graph view (purpose-built, MIT, actively maintained, tiny API surface, and it
already does what we need: pan/zoom/hover/click on a WebGL canvas). Fall back to
cosmos if 100k nodes is still too slow, and to pixi.js only if sigma's look cannot be
made to match.

## Steps
1. Vendor sigma + graphology + a layout (`graphology-layout-forceatlas2`) locally into
   `data/` (no CDN).
2. Build `variants/<g>__s00-sigma.html` from the same graph.json: graphology graph,
   forceatlas2 layout (or the baked x/y we already compute), sigma WebGL renderer.
   Keep the same capability set: node colour by community, size by degree, labels,
   edge colour by confidence, direction visible, hover/click inspector.
3. Measure with a sigma-aware battery: **pan fps, zoom fps, hover fps, load_ms** on
   rsl and continuum, head to head with vis-network.
4. Only if sigma wins on felt fps: integrate into `graphify/exporters/html.py` behind
   the existing features, keep small-graph output unchanged, add regression tests.

## Status
**PARKED 2026-10-17 — the user rejected this path.** The numbers were decisive (pan
4.8 -> 90-110fps, zoom -> 106fps) but the user judged the sigma prototype **ugly**, and
reaching parity would mean rewriting arrowheads, the community legend, search, the click
inspector, hyperedges, the learning overlay and the >5000-node aggregate path. Work moved
to lane L8 instead (gesture latency attribution inside vis-network), which found a 4x
smoothness win with no visual change. The measurement below stands on its own if a WebGL
renderer is ever revisited.

**SIGMA WINS ON FELT FPS (2026-10-17).** Same graph (rsl 1886/3876), same elapsed-time
camera driver, same headless session, **real GPU** (headless Chrome uses the Intel UHD via
ANGLE/D3D11 by default — verified with `harness/gl_probe.mjs`):

| render | pan fps | zoom fps | hover fps | load_ms | longtask_total | heap |
|---|---|---|---|---|---|---|
| shipped vis (users have this) | **4.8** | 9.6 | 15.2 | 3266 | 5915 | 12.1 |
| ours, tuned vis (a01) | 9.2 | 42.0 | 139.6 | 2913 | 0 | 12.7 |
| **ours, sigma/WebGL (s01)** | **90.4-110.0** | **106.4** | 141.6 | 2600 | **0** | 8.9 |

i.e. **~19x the pan framerate of the shipped render** and ~2x the tuned canvas one, with zero
long tasks and a smaller heap. The user's "no notable difference" verdict is explained exactly
by the first two rows (4.8 -> 9.2 fps is imperceptible); sigma crosses the felt threshold.

Artifacts: `harness/build_sigma.py` (prototype generator), `harness/measure_sigma.mjs`
(sigma-aware battery), `harness/fetch_libs.py` (vendors sigma 4.0.3 + graphology 0.26.0 into
`data/`), `harness/gl_probe.mjs`. Live prototype: `view/sigma.html` (has a live fps HUD).

IMPORTANT correction: an earlier sigma run used `--use-gl=swiftshader` and reported pan 18.8 /
zoom 4.8. That was **software WebGL** and is invalid; the numbers above are the real GPU ones.

Known gaps in the prototype (it is a renderer spike, not a drop-in): no arrowheads/direction
rendering, no community legend/filter, no search, no inspector parity, no hyperedges/learning
overlay, no >5000-node aggregate path.

## Next
Integrate sigma into `graphify/exporters/html.py` without losing capabilities: direction
(arrowheads via sigma edge `type: 'arrow'`), community legend + filter, search, click
inspector, hyperedges, and the aggregate path for very large graphs. Keep the vis render as
a fallback until parity is proven, then flip the default.
