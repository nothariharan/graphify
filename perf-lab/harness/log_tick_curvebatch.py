"""Append tick 3 (curve fidelity) to the lab logs.

  python harness/log_tick_curvebatch.py
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


DECISIONS = """D39\t2026-10-17\tThe batched edge pass draws the curve vis draws at rest (quadratic through vis's own via point), not a straight line\tStraight lines are cheaper but they are a visibly different graph in motion: a mid-gesture frame diffed against the resting frame at the same camera changed 82-104% of painted pixels with straight lines versus 1.1-1.8% with the curve. The curve costs nothing measurable (same interleaved run: straight 79.4/69.3/78.5 vs curved 82.9/78.9/80.4 fps node/pan/zoom)\tprobe_motion_pixels.mjs on the noborder builds (straight vs curved), results/ab-rsl-v7-certified.csv\tadopted
D40\t2026-10-17\tMeasure gesture fidelity as a pixel diff between the in-motion frame and the resting frame at the same camera, on builds where the other levers are made no-ops\t\"Did the graph change while moving?\" is exactly the class of complaint that started this work (edges vanishing), and it cannot be judged by eye on a dense coloured graph - two screenshots of 3876 edges look 'the same' whether or not every edge moved. Snapshot while the gesture is held, release so vis redraws the frozen camera through its normal path, diff the framebuffers\tmk_batch_curved.py (noborder builds) + probe_motion_pixels.mjs\tadopted
D41\t2026-10-17\tWhen taking over vis's draw, reproduce vis's own primitive and verify the arithmetic against vis's own function, rather than eyeballing an approximation\t_curveTo re-implements BezierEdgeDynamic._getViaCoordinates for continuous smooth edges, and probe_edgebatch.mjs asserts our via against edgeType.getViaNode() for every edge (worst disagreement 0.0 across 3876). Only the grouping differs from vis, which is why the residual diff is dash phase and node endpoints, not edge shape\tprobe_edgebatch.mjs --file variants/base-ours-v7.html\tadopted
"""

LOG = """- 2026-10-17 L8 tick 3: the batch shipped in tick 2 drew straight lines in motion. Cheap, but it is not the rest-of-the-time picture - and the way to see that is a pixel diff, not an eye test. New probe_motion_pixels.mjs freezes a pan/zoom mid-gesture, grabs the graph canvas, releases so vis redraws the SAME camera through its own per-edge path, and compares framebuffers. Straight lines: 81.8% of painted pixels changed on a pan (worst channel delta 255), 103.8% on a zoom. Curves: 1.75% and 1.12%.
- 2026-10-17 L8 tick 3: that test only isolates the edge pass if the other levers are quiet, so mk_batch_curved.py builds "noborder" copies (BORDER_LEAN = 1.5, a no-op) from the shipped v7 artifact. The residual 1-2% is dash phase (setLineDash is per-path, so grouping shifts the phase of the 393 dashed edges) and the node endpoints - not edge geometry.
- 2026-10-17 L8 tick 3: ported the curve into the exporter. _curveTo reproduces vis's own via arithmetic for smooth:{type:'continuous'} (offset from `from` by roundness * the dominant extent, signed toward `to`, clamped into the segment's box); anything else falls back to a line. Verified against vis: probe_edgebatch now asserts our via against edgeType.getViaNode() for all 3876 edges - worst disagreement 0.0. Mid-gesture the canvas emits 20 strokes and 3876 quadraticCurveTo, i.e. the same curve type and count as at rest (at rest: 5762 strokes, 3876 quad, 0 lineTo).
- 2026-10-17 L8 tick 3: curves turned out to be free. Same interleaved run, straight vs curved: node 79.4 vs 82.9, pan 69.3 vs 78.9, zoom 78.5 vs 80.4 fps. The earlier run that suggested curved was 36% slower on zoom was round drift - round 3 of this run shows both variants dipping together.
- 2026-10-17 L8 tick 3 CERTIFIED (results/ab-rsl-v7-certified.csv, 3 rounds, vs a fresh HEAD build): node drag 40.4 -> 82.9 fps (x2.05), pan 39.1 -> 78.9 (x2.02), zoom 15.2 -> 80.4 (x5.29); stalled frames 13/14/91 per 90 -> 1/1/0. Note the before column is running FAST in this run (40fps where the earlier certification had 15) - the host regime, not the code, decides the ratio (x1.7-x5.8 across runs).
- 2026-10-17 L8 tick 3: tests/test_html_perf_levers.py 20 tests (new test asserts the curve path, the non-continuous fallback and the via clamp). Both served pages smoke clean (1886 nodes / 3876 edges / 1886 drawn, physics off, no JS errors). view/after.html rebuilt from base-ours-v7.html. Mid-gesture shots: shots/curved-pan-held.png, shots/curved-zoom-held.png.
"""

LANE = """
# Curve fidelity: what "in motion" actually looked like (2026-10-17 tick 3)

The batched pass from tick 2 drew `moveTo(from); lineTo(to)` per edge. That is the cheapest
possible stroke and every line stays on screen - but it is not the picture the graph shows at
rest, where `smooth: {type: 'continuous', roundness: 0.2}` bends every edge slightly. On a
dense coloured graph nobody can see that by eye in a screenshot; you have to diff frames.

## How it was measured

`probe_motion_pixels.mjs`:

1. hold a pan (real pointer events) or a zoom (wheel events), camera frozen;
2. snapshot the graph canvas backbuffer;
3. release so vis redraws **the same camera** through its normal per-edge path;
4. diff the two framebuffers (count pixels whose worst channel delta > 16).

It runs on the "noborder" builds (`mk_batch_curved.py` sets `BORDER_LEAN = 1.5`, a no-op),
otherwise the legitimately-missing node borders would swamp the edge question.

| frame in motion vs same camera at rest | straight batch | curve-faithful batch |
|---|---|---|
| pan | **122454 px changed = 81.8%** of painted (worst delta 255) | **2617 px = 1.75%** (worst 79) |
| zoom | **278625 px = 103.8%** of painted (worst 255) | **3001 px = 1.12%** (worst 72) |

So "straight in motion" is not a subtle optimisation, it is a different graph: essentially
every edge pixel moved. The curve version leaves ~98% of the painted frame untouched.

The residual 1-2% is **dash phase** (`setLineDash` applies to the whole path, so grouping the
393 dashed edges into one subpath shifts each one's dash phase) plus the node endpoints, not
edge shape. Dashes are still dashes, in the same colour, on the same edges.

## Shipping it

`_curveTo` in the exporter reproduces vis's own arithmetic for `continuous` smooth edges
(`BezierEdgeDynamic._getViaCoordinates`, the fall-through branch): offset from `from` by
`roundness * dominantExtent`, signed toward `to`, then clamped into the segment's box.
Anything that is not a continuous smooth edge falls back to `lineTo`.

`probe_edgebatch.mjs` on the shipped `base-ours-v7.html`:

| check | result |
|---|---|
| at rest | 5762 strokes, **3876 quadraticCurveTo**, 0 lineTo |
| mid pan | **20 strokes**, 3876 quadraticCurveTo, 0 bezierCurveTo |
| mid node drag | 20 strokes, 3876 quadCurve, dragged node's live coord in the moveTo set |
| after release | 5762 strokes, 3876 quadCurve - identical to at rest |
| our via vs vis's `edgeType.getViaNode()` | 3876 edges checked, **worst disagreement 0.0** |
| colour set | identical to rest (30 colours) |
| dashes | dashed groups keep `[5,5]`; vis's own `setLineDash([0])` reset is replaced by save/restore |

That first row is the point of this tick: in motion the canvas emits the *same curve primitive,
the same number of times*, as it does at rest. Only the stroke count differs (3876 -> 20).

## Curves are free

An earlier 3-variant run made curves look 13-36% slower on pan/zoom. That was round drift:
round 3 of the next run dipped both variants together. In one interleaved run (same rounds,
same host):

| variant | node | pan | zoom |
|---|---|---|---|
| straight batch | 79.4 | 69.3 | 78.5 |
| curve-faithful batch | **82.9** | **78.9** | **80.4** |

## Final certification, `results/ab-rsl-v7-certified.csv` (3 rounds, rsl, vs a fresh HEAD build)

| gesture | before (HEAD) | shipped (v7) | stalled >33ms /90 |
|---|---|---|---|
| node drag | 40.4 fps | **82.9 (x2.05)** | 13 -> 1 |
| pan drag | 39.1 | **78.9 (x2.02)** | 14 -> 1 |
| zoom | 15.2 | **80.4 (x5.29)** | 91 -> 0 |

The `before` column is running fast in this run (40fps where the earlier certification measured
15). That is the host regime, not the code: the same shipped file measured 15.0 and 43.7fps in
consecutive rounds of one mode-new run. The paired ratio across all certified runs of this lever
spans **x1.7-x5.8**; the honest claim is the ratio and the stall count, never a bare fps.
"""
append(os.path.join(LAB, "DECISIONS.tsv"), DECISIONS)
append(os.path.join(LAB, "LOG.md"), LOG)
append(os.path.join(LAB, "lanes", "L8-gesture-latency.md"), LANE)
