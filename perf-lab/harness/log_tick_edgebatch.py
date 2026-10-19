"""Append this tick's findings to the lab logs (DECISIONS.tsv, LOG.md, lanes/L8).

  python harness/log_tick_edgebatch.py
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)


def append(path, text):
    eol = "\r\n" if "\r\n" in io.open(path, "rb").read(20000).decode("utf-8", "replace") else "\n"
    s = io.open(path, encoding="utf-8", newline="").read()
    if not s.endswith("\n"):
        s += eol
    io.open(path, "w", encoding="utf-8", newline="").write(s + text.replace("\n", eol))
    print("appended to", os.path.relpath(path, LAB))


DECISIONS = """D33\t2026-10-17\tNever hide edges during a gesture: hideEdgesOnZoom (added by us) and hideEdgesOnDrag (shipped default, inherited) are both removed\tThe user reported lines vanishing while zooming and while panning - the graph appeared to fall apart in motion. Measured before removal: during a pan the shipped build strokes 24240x @ lineWidth 18.13 and ZERO edges; during a zoom it strokes 7752 edge segments per frame (so the shipped build already hid edges on pan; we had added the zoom case)\tprobe_borderdraw.mjs pan/zoom stroke+lineWidth histograms on base-rsl-head / base-ours-v4 / base-ours-v5\tadopted
D34\t2026-10-17\tMake edges cheap instead of absent: batch the edge pass into one ctx.stroke() per (colour, dashes, width) group for the length of the gesture\tWith edges visible the border lean alone only reached x1.41-1.45 and stayed at 89-91/90 stalled frames; 3876 per-edge stroke() calls (~30ms) are the frame. Grouped batching costs 20 strokes for the same 3876 lines, x2.27-5.79 over the shipped build, stalls 8-16/90, with every line/colour/dash still drawn\tprobe_edgebatch.mjs (20 strokes, 3876 lineTo, colour set identical to rest) + ab_drag.mjs 3 rounds certified on base-ours-v6\tadopted
D35\t2026-10-17\tDo NOT lean edges by writing edge.options.smooth / edge.options.width\tDead end, proven: vis resolves the draw from the live instance options (Edge.draw -> getFormattingValues -> edgeType.drawLine) and picks the curve implementation class once in updateEdgeType(); mid-gesture all 3876 edges reported smooth:false + width:1 while the canvas still emitted 0 lineTo, and the drawn lineWidth stayed 3.63 because getFormattingValues floors width at max(w, 0.3/scale)\tedge options mutation probe (debug_edgelean.mjs) + vis-network.min.js draw path\tadopted
D36\t2026-10-17\tRe-derive the batched lineWidth per frame as max(options.width, 0.3/scale) instead of baking it in at gesture start\tthe 0.3/scale floor moves with the zoom, so a width captured at dragStart is wrong by the time the user zooms; the group key carries the unfloored base width and the floor is recomputed each frame\tvis getFormattingValues + probe fidelity check\tadopted
D37\t2026-10-17\tThe edge batch falls back to vis's own draw if it throws, and uninstalls itself after 2 errors\ta throwing drawLine replacement would blank the canvas for that frame; the catch calls the original drawLine and repeated failure disables the lever rather than leaving a broken render\tcode path in _EDGE_BATCH + tests/test_html_perf_levers.py\tadopted
D38\t2026-10-17\tOdd round counts for A/B, and never read a median-of-two\tThe host swings ~3x inside one render mode: the SAME shipped file measured 15.0fps in round 1 and 43.7fps in round 2 of one mode=new run, and median-of-two silently reported the better one (43.7) next to the worse one's jank (89). This is also the most likely reason the user 'felt nothing' - on a host sitting in the fast regime the shipped build is already ~44fps, so the same build that is 15fps here is not 15fps there\tab_drag.mjs --mode old/new/window runs + results/mode-new.csv\tadopted
"""

LOG = """- 2026-10-17 L8 (user report): user says the after version's lines DISAPPEAR while zooming and while panning, and that they do not feel a significant perf gain. Both complaints are real: hideEdgesOnZoom was ours, hideEdgesOnDrag was the shipped default we had inherited.
- 2026-10-17 L8: render-mode diagnostic first, to test whether the rig itself was the reason for 'no felt gain' - ab_drag.mjs --mode old/new/window. GPU is the real Intel UHD via ANGLE/D3D11 in every mode (not swiftshader). But mode=new round 1 vs round 2 on the SAME shipped file: 15.0fps vs 43.7fps. The host swings ~3x inside one mode, so absolute fps from any single run is meaningless and a 2-round median lies (it reports the upper value next to the lower value's jank).
- 2026-10-17 L8: removed hideEdgesOnDrag + hideEdgesOnZoom from the exporter (interaction block is now hover/tooltipDelay/navigationButtons/keyboard only). tests/test_html_perf_levers.py grew a test that asserts neither option is emitted on a small or a dense graph (comment lines stripped, since the prose names them).
- 2026-10-17 L8: stroke-probe proof of the user's report, extended probe_borderdraw.mjs with a wheel-driven zoom mode. During a PAN: shipped = 24240 strokes @ lineWidth 18.13 (borders only, zero edges - already hiding), v4 = 0 strokes, v5 = 50388 edge strokes @ 3.63. During a ZOOM: shipped = 74906 strokes including 7752 edge segments, v4 = 0 (our addition hid everything), v5 = 50388 edge strokes. So the pan complaint predates us; the zoom complaint was ours.
- 2026-10-17 L8: cost of honesty - with edges visible (v5) the lean draw alone is node x1.41, pan x1.45, zoom x3.41 and STILL 89-91/90 stalled frames (~21fps). Edges are ~2x the node-border cost and are not optional any more, so the edge draw itself had to get cheaper.
- 2026-10-17 L8: tried leaning the edges (straight during gestures) two ways. (a) writing edge.options.smooth=false + width=1 mid-gesture: PROVEN DEAD - mid-pan all 3876 edges report smooth:false/width:1 while the canvas still emits 0 lineTo (bezier path unchanged), because vis caches the curve class in updateEdgeType() and floors width inside getFormattingValues. (b) swapping each edgeType._line for the straight implementation vis's own no-smooth class uses: works (0 bezierCurveTo, 19380 lineTo mid-pan) and measured node x1.73, pan x1.58, zoom x4.14 - kept as variants/edge-lean-dynamic.html, superseded by the batch below.
- 2026-10-17 L8 CEILING TEST: varying every edge as one single path (deliberately wrong colours) mid-gesture -> node 42.0, pan 42.1, zoom 45.8fps with jank 7/90 vs 89. That settled it: batching is worth building properly.
- 2026-10-17 L8 RESULT batched edge pass (_EDGE_BATCH): replace edgeType.drawLine per edge for the gesture, stroke each (colour, dashes, width) group once. On rsl the 3876 strokes collapse to 20. Endpoints are read live each frame (edgeType.fromPoint IS the node object) so dragged-node edges follow; the patch is deleted on release so the next frame is byte-identical to unbatched. Certified vs a fresh HEAD build, interleaved 3 rounds: node 15.0 -> 39.7 (x2.65), pan 15.4 -> 34.9 (x2.27), zoom 6.3 -> 36.5 (x5.79), jank 89-91/90 -> 8-16/90.
- 2026-10-17 L8: new harnesses this tick - ab_drag.mjs --mode old|new|window (render-path control), probe_edgebatch.mjs (batch fidelity: stroke count, lineTo count, colour/dash set vs rest, live-endpoint check, restore check), shot_gesture.mjs (screenshot taken WHILE a gesture is held, so the in-motion look can be eyeballed), grep_ctx.py (minified-source context reader). variants: edge-visible-curved, edge-straight-static, edge-lean-dynamic, edge-batch-ceiling, edge-batch-real.
- 2026-10-17 L8: tests 19 pass in tests/test_html_perf_levers.py; broader -k "html or exporter or viz" 133 passed, 1 pre-existing environmental failure (test_hooks.py shells out to sh on Windows). view/after.html rebuilt from base-ours-v6.html; both served pages smoke-tested clean (1886 nodes / 3876 edges / 1886 drawn, physics off, no JS errors).
"""

LANE = """
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
"""

append(os.path.join(LAB, "DECISIONS.tsv"), DECISIONS)
append(os.path.join(LAB, "LOG.md"), LOG)
append(os.path.join(LAB, "lanes", "L8-gesture-latency.md"), LANE)
