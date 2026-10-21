# L22 — the node disc without the border stroke

## Hypothesis

The resting frame is node-bound, not edge-bound. L9 said the node pass is "the floor" and
that there is no safe seam in vis's node draw. L12 removed the edge cost, so the node pass
is now the whole story. Hypothesis: a large part of the node pass is the *border* stroke -
one `ctx.stroke()` per node per frame - and it can be removed without changing the picture,
because the exporter paints every node's border in the same colour as its fill.

## Attribution (rsl, 1886 nodes / 3876 edges, `probe_frame_parts.mjs`, `probe_node_time.mjs`)

| configuration | frame (p50) |
|---|---|
| shipped | 85.7 ms |
| node shapes stubbed out | 22.6 ms |
| edge batch uninstalled (vis draws 3876 edges) | 104.2 ms |
| both | 39.6 ms |

So the node pass is ~63 ms of the 86 ms frame. But the *JavaScript* inside vis's per-node
draw is only 16.7 ms (13.2 ms of it in `shape.draw`), and replaying the same 1886 dots on
the same canvas costs 2.4 ms. The rest is the rasterizer.

**The border is the cost.** vis draws a node as a fill of radius `size/2` plus a border
stroke whose *world* width is `min(nodeWidth, 1.5/scale)` (`initContextForDraw` in the
pinned 9.1.6 bundle: `e = t.borderWidth / this.body.view.scale; g.lineWidth = Math.min(this.width, e)`).
At the fit scale (0.08) that stroke is as wide as the node itself, so the node you see is a
disc **twice** its fill radius, and it is 1886 hairline strokes per frame.

| build | frame (p50) |
|---|---|
| shipped (border stroke) | 85.7 ms |
| `borderWidth: 0` (nodes also 44% smaller on screen) | 28.9 ms |
| `borderWidth: 0` + the size grown so the disc is the same size | **30.9 ms** |

The third row is the honest one: the picture is the same and the frame is 2.8x faster.

## Method

`size' = size + min(size, 1.5/scale)` is exactly the disc vis draws (fill radius plus the
border's outer half), so the border can be replaced by a slightly larger fill of the same
colour. The size depends on the zoom, so it is refreshed whenever the scale changes - and
**not** while the solver runs, so the layout still sees the sizes the exporter shipped and
the picture is the same as the unbaked one.

Hovered and selected nodes keep a real border, because theirs is white
(`color.hover.border` / `color.highlight.border`) and therefore visible: their size goes
back to the shipped size and the border is restored.

Instruments: `probe_frame_parts.mjs` (frame split), `probe_node_time.mjs` (time inside
vis's draw), `probe_node_raster.mjs` / `probe_node_canvas.mjs` (raster floor), `probe_frame_cmp.mjs`
(cross-build pixel diff at a fixed camera), `probe_node_ring.mjs` (real mouse click, white
ring), `ab_rest.mjs` (interleaved rest + hover A/B).

## Results

Interleaved 3 rounds, `results/ab-rest-L22-v12.csv`, v10 (shipped) vs v12 (this lane):

| | v10 | v12 | ratio |
|---|---|---|---|
| rest frame p50 | 84.0 ms | 27.9 ms | **x0.33** |
| hover cycle p50 | 85.6 ms | 29.1 ms | **x0.34** |

Per round: rest 84.0 -> 27.4, 79.6 -> 27.9, ~85 -> 28.7; hover 85.6 -> 28.8, 88.4 -> 29.3,
83.6 -> 29.1. All six pairs favour the new build. The scratch variant measured the same
way (`results/ab-rest-L22.csv`): rest 85.1 -> 28.2, hover 81.3 -> 27.7.

Gestures, interleaved 3 rounds against the previous shipped state in the same session
(`results/ab-rsl-v8-v12.csv`, v8 = the lean/edge-batch build, v12 = this lane):

| gesture | v8 | v12 | ratio | jank >33 ms |
|---|---|---|---|---|
| node drag | 28.2 fps | 34.9 fps | x1.24 | 44 -> 21 |
| pan | 25.2 fps | 33.9 fps | x1.35 | 60 -> 27 |
| zoom | 30.8 fps | 30.3 fps | x0.98 | 52 -> 50 |

The first attempt (v11) removed the lean entirely, because with the border gone there
seemed to be nothing left to drop. That was wrong: a **drag measured 33% slower** without
it (`results/ab-rsl-v8-v11.csv`, node drag 37.7 -> 25.3 fps, jank 17 -> 67). The lean is
not about the border, it is about the *size* of the disc: a drag draws the small discs, and
the small discs are cheaper. So the lean now shrinks the fill instead of dropping a
stroke, which keeps the old look and the old speed (v12 above).

Capability on the shipped artifact (`variants/base-ours-v12.html`):

| check | result |
|---|---|
| white selection ring (real mouse click, zoom 2) | 446 white pixels (v10: 446) - the ring is intact |
| arrowhead on a hovered edge | enabled, 96 px changed |
| selected edge | 163 px changed, 0 px still different after deselect |
| legend toggle (hide community 0) | 7880 px changed, restored to 0 |
| zoom / lean / batch coexist | 3876 edges overridden, 0 white, 0 dimmed, no errors |

Picture: cross-build diff at a fixed camera with an identical layout (`probe_frame_cmp.mjs`,
v10 vs v11) - **3.02% of painted pixels differ**, 0 pixels painted in v10 that v11 does not
paint, 1147 that only v11 paints (0.6 px per node). The nodes are 1-2 px at the fit scale
and the difference is the anti-aliased edge of a dot: a fill's edge against a stroke's edge.
Screenshots `shots/L22-v11-rest.png` and `shots/L17-ref-v10.png` show the same picture.

The disc follows the zoom, because the border it replaces was a screen-constant width:
at the fit scale the size is 22.4 (11.2 + 11.2), at scale 0.5 it is 14.2 (11.2 + 3), at
scale 2 it is 11.95 (11.2 + 0.75) - exactly the disc vis draws at every level.

## Verdict

Ship it. The resting frame and every interaction that repaints it (hover, selection, a
legend toggle) are about **3x faster** on the same picture, and the gestures are 1.2-1.35x
faster than the build they replace.

## Against the right baseline

The lab's first baseline was the perf branch's pre-perf snapshot, which turned out to be two
milestones behind the user's own checkout (see the baseline ladder in `AGENTS.md`). The
honest comparison, 5 interleaved rounds, `results/ab-rsl-checkout-v12-5r.csv`:

| gesture | the user's checkout (3a09ba73) | v12 | ratio | jank >33 ms |
|---|---|---|---|---|
| node drag | 38.3 fps | 36.9 fps | x0.96 | 20 → 16 |
| pan | 30.8 fps | 37.2 fps | **x1.21** | 38 → 19 |
| zoom (3 rounds) | 32.0 fps | 34.2 fps | x1.07 | 40 → 29 |

So against what the user actually has today: the drag is level, the pan is 21% faster with
half the jank, the zoom 7% faster, and the resting frame and the hover redraw are 3x
faster. Against the *released* main (which still hides the edges while you drag) it is
x2.26 / x2.26 / x5.42.

## L23: the dashed edges (measured, not adopted)

L12 hands the 393 dashed (INFERRED confidence) edges back to vis so their dash rendering is
vis's own, which costs 393 extra strokes per frame. Putting them back into the batch
(`harness/mk_l23.py`, scratch build `variants/base-L23-dashbatch.html`) changes nothing
measurable:

- at-rest parity 9.81% vs 9.83% - the exclusion was never buying fidelity,
- gestures: node x1.01, pan x0.98, zoom x0.90 (`results/ab-rsl-v12-l23.csv`) - noise.

So the exclusion stays (fewer moving parts, the confidence texture is exactly vis's) and
the 393 strokes are not what the drag gap was about. The drag gap against the checkout was
host noise: the 3-round run said x0.85, the 5-round run says x0.96.
