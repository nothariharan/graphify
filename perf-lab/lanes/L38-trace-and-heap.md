# L38 — trace & heap audit of the dense zoom (OBSERVATION ONLY, no fix)

**Status:** traced and documented. No code change. No fix applied. Awaiting the user's direction
before any lever is attempted.

**Scope:** the shipped artifact `variants/base-ours-v25.html` (the desync-canvas build, commit
`6b46384b`), measured on the rsl graph (1886 nodes / 3876 edges / 141 communities) in the dense
core at scale 5 (deep zoom), 2560x1440, headless Chrome. Comparison numbers for the official
viewer come from the earlier certified runs in `results/ab-rsl-official-v15.csv` and the L34
trace (`probe_lag_hunt.mjs`).

## What was traced

| instrument | what it captures | file |
|---|---|---|
| `probe_inp.mjs` | Chrome Event Timing INP breakdown (input delay / processing / presentation) | `results/` (console) |
| `probe_zoom_trace.mjs` | CPU profile + DevTools timeline (script/style/layout/paint/raster) + wheel→paint latency + redraw stacks | `results/trace-zoom-v25.json` |
| `probe_profile_frame.mjs` | forced resting-frame CPU profile (which functions) | `results/trace-profile-frame-v25.txt` |
| `probe_frame_attrib.mjs` | per-frame gap vs JS-draw vs browser-presentation attribution | `results/trace-frame-attrib-v25.txt` |
| `probe_path_extent.mjs` | strokes / subpaths / device-space px of path per frame, solid vs dashed | `results/trace-path-extent-v25.txt` |
| `probe_raster_flush.mjs` | JS draw time vs raster+readback flush time (the forced raster) | `results/trace-raster-flush-v25.txt` |
| `probe_raster_micro.mjs` | what the rasterizer charges for: path count, dash, subpaths | `results/trace-raster-micro-v25.txt` |
| `probe_lag_hunt.mjs` | random moves, bad-frame attribution, CPU profile correlation | `results/trace-lag-hunt-v25.txt` |
| `probe_heap_trace.mjs` (new) | CDP HeapProfiler snapshots before/after a gesture, GC forced, top growing constructors | `results/trace-heap-v25.json`, `trace-heap-v25-100.json` |

## Findings

### 1. The JS draw is not the bottleneck
- `probe_frame_attrib.mjs`: JS draw mean 12.6 ms, max 30.6 ms. Frame gap p50 7.0 ms, p95 69.5 ms,
  p99 125.1 ms, max 132 ms. **0 of the 26 bad frames were mostly our JavaScript; 26 were the
  browser's presentation.**
- `probe_profile_frame.mjs`: resting frame profile is dominated by `value @ vis-network.min.js`
  (~30% in aggregate across several `value` entries) and V8 internals (`fill`, `save`,
  `restore`, `stroke`, `closePath`); our own code is `_arrowed` 2.7%, `_drawAll` 2.4%,
  `_curveTo` 1.3%, `_nbApplyNode` is in the zoom path. 15.4% is `(idle)` (the forced-frame
  settle).
- Conclusion: the synchronous JavaScript is ~13 ms. The lag is not in our JS.

### 2. The raster is the cost
- `probe_raster_flush.mjs`: JS draw p50 19.4 ms, flush (raster + readback) p50 156.6 ms. The
  raster of the frame is ~154.4 ms. So the CPU-forced raster of the canvas is ~8x the JS draw.
- `probe_path_extent.mjs`: per frame 427 strokes, 3876 subpaths, **10.77 M px of path**,
  393 dashed subpaths, 24 node fills, maxW 3.50. The geometry is large: 10.77 M device-space
  pixels of path per frame.
- `probe_raster_micro.mjs`: rasterizing 3876 solid quadratic curves costs 1.9-2.1 ms. But 20
  dashed paths cost 20.7 ms. The dash pattern (`setLineDash`) is ~10x more expensive to
  rasterize per path. In the real frame the 393 dashed edges are each their own stroke (one
  subpath each), so their raster cost is small in aggregate (the micro's 3876 dashed paths
  cost 1.7 ms), but the solid 10.77 M px of path dominates.

### 3. The presentation delay is the user-visible lag
- `probe_inp.mjs` (v25): INP presentation p50 47-94 ms (run-to-run variance), vs the official
  (edges hidden) 147-152 ms. The desync canvas (L37) cut it 3x (166 -> 55 ms typical).
- `probe_zoom_trace.mjs` (v25): wheel -> next paint p50 0 (the trace's paint matching is
  unreliable on this build — the `DrawFrame` events are not captured with these categories);
  CPU 1873 ms over 14 notches, top: `(idle)` 1265 ms, `(program)` 335 ms,
  `value @ vis-network.min.js` 152 ms, `_arrowed` 25 ms, `_nbApplyNode` 19 ms,
  `setLineDash` 9.5 ms, `stroke` 8.2 ms, `save` 7.4 ms, GC 7.0 ms, `_curveTo` 5.4 ms,
  `quadraticCurveTo` 5.2 ms, `moveTo` 4.4 ms.

### 4. The heap is not growing
- `probe_heap_trace.mjs` (14 gestures): runtime usedSize +0.10 MB, totalSize +0.00 MB,
  snapshotUsed +0.10 MB. Top growers are V8 JIT internals (InstructionStream +61 KB,
  TrustedByteArray +17 KB, FeedbackVector +6 KB, Code +2 KB) — code caching, not app data.
  Largest app-adjacent entry: `PerformanceLongAnimationFrameTiming` +3 instances / +0.3 KB.
- `probe_heap_trace.mjs` (100 gestures): runtime +0.16 MB, total +0.50 MB. Same V8-internal
  growers, slightly larger counts. No retained growth in our own objects (no node/edge arrays,
  no caches, no listeners accumulating).
- Conclusion: there is no JS-level memory leak during a zoom gesture. The heap is stable.
  The lag is not memory pressure.

### 5. Where the lag originates (synthesis)
The user's complaint ("400 ms+ frames when zoomed into a dense area and moving around") is
the **GPU/compositor raster of the canvas layer**, not our JavaScript and not memory:

1. Each frame draws 10.77 M device-space pixels of path (3876 edges + 393 dashed + 24 nodes).
2. The CPU JS draw records those commands in ~19 ms.
3. The canvas is GPU-accelerated, so the actual raster happens at composite time on the GPU.
4. On the user's machine that GPU raster costs ~154 ms (measured via the forced flush).
5. The desync canvas (L37) decouples the canvas from the compositor so the frame is presented
   on the next vsync instead of being queued behind the compositor's backlog — presentation
   drops from ~166 ms to ~47-94 ms (3x). That is the lever already shipped (v25).
6. Tail frames still hit 100-132 ms (frame_attrib): those are the compositor's occasional
   long raster passes, not JS.

The remaining lever surface (NOT yet attempted, NOT yet decided):
- Reduce the device-space path length per frame (fewer px of path). The dashed edges are the
  expensive per-path case (20.7 ms for 20 dashed paths vs 2.1 ms for 3876 solid paths).
- Force the canvas onto the software (CPU) raster path (`willReadFrequently: true`) — measured
  worse on its own (126 ms) but the combination with desync was 71 ms; desync alone (55 ms) won.
- Move the raster off the main thread (OffscreenCanvas + worker) — not yet tried.
- Reduce the canvas backing-store resolution (devicePixelRatio) — trades sharpness, needs user
  sign-off.
- Cull edges to the viewport — already tried and rejected (L35: bbox test costs more than the
  strokes it skips; p95 0.93x, no significant change).

## Tests added
None this tick. The user explicitly asked for traces and tests only, no fixes. The existing
43 tests in `tests/test_html_perf_levers.py` remain green (last run: 43 passed).

## What is NOT being done this tick
- No exporter change.
- No artifact rebuild.
- No commit of code. (Docs-only commit follows.)
- No push (never).

## Next decision (for the user)
The trace says the lag is the GPU raster of 10.77 M px of path per frame, of which the
dashed-edge dash pattern is the per-path expensive case. Candidate levers, in order of
likely impact and risk:
1. Reduce dash raster cost (e.g. pre-bake dashed edges as solid segmented paths, or drop dashes
   below a scale threshold) — needs a parity proof (probe_motion_pixels).
2. Lower the canvas devicePixelRatio on dense graphs — trades sharpness.
3. OffscreenCanvas + worker raster — large rewrite, risky.
4. Accept the desync win (47-94 ms) as the floor for canvas 2D.

Awaiting direction before any of these is attempted.
