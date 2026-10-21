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

Interleaved 3 rounds, `results/ab-rest-L22-shipped.csv`, v10 (shipped) vs v11 (this lane):

| | v10 | v11 | ratio |
|---|---|---|---|
| rest frame p50 | 93.5 ms | 22.6 ms | **x0.24** |
| hover cycle p50 | 85.6 ms | 21.5 ms | **x0.25** |

Per round: rest 87.7 -> 19.4, 94.4 -> 22.6, 93.5 -> 27.5; hover 92.9 -> 21.5, 83.8 -> 20.8,
85.6 -> 29.3. All six pairs favour the new build. A scratch variant measured the same way
(`results/ab-rest-L22.csv`): rest 85.1 -> 28.2, hover 81.3 -> 27.7.

Capability on the shipped artifact (`variants/base-ours-v11.html`):

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

The lean lever is now redundant and was removed: with the border gone for good there is
nothing to drop for the length of a gesture, which also means the nodes no longer change
size when the pointer goes down (they used to halve at the fit scale while a drag was live).

## Verdict

Ship it. The resting frame and every interaction that repaints it (hover, selection, a
legend toggle) are about **4x faster** on the same picture, and one more source of jank -
the nodes shrinking and growing at drag start and end - is gone.
