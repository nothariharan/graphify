# L29 — zooming into the dense centre: what actually costs, and what does not

## The complaint

> "when I zoom closer on the part where we have many nodes like the centre of the graph it's
> getting crazy laggy"

## The attribution (and two traps in the instruments)

**Trap 1: the frame interval is quantised to vsync.** A probe that measures
`network.redraw(); await rAF` reports 16.7 ms steps: the "50 ms frame" at scale 0.66 is three
vsyncs, not 50 ms of JavaScript. Reading it as draw cost sends you after the wrong thing.

**Trap 2: the draw is cheapest when you zoom in.** Measured synchronously
(`harness/probe_draw_sync.mjs`, `network.canvas.redraw()` timed directly), centred on the
densest node of rsl:

| zoom | scale | nodes on screen | sync draw |
|---|---|---|---|
| fit | 0.083 | 1 610 | 21.6 ms |
| x4 | 0.331 | 333 | 10.5 ms |
| x8 | 0.662 | 157 | 6.9 ms |
| x24 | 1.986 | 28 | 5.2 ms |

So the canvas draw is *not* what gets worse when you zoom into a cluster: vis culls the
nodes and the batch draws fewer curves. Whatever the user feels there is happening outside
the draw.

## Option A (cull the edge batch to the viewport) — implemented, measured, REJECTED

The batch strokes every edge in the graph no matter where the camera is (at x8 only 834 of
3 483 edges are on screen). A world-space bbox test per edge was added to `_drawAll`
(`_onScreen` + `_viewRect`) and the build measured against the same build without it: the
draw went **25.8 vs 21.6 ms at fit, 8.6 vs 6.9 at x8, 10.7 vs 5.2 at x24** - the cull cost
more than the strokes it skipped, because the strokes are not the bottleneck in the first
place. Reverted (`git checkout`), and the code is not in the tree.

## What was actually wrong: every hover rebuilt the world

`_syncArrows()` runs on every `hoverNode` (dense graphs defer the arrowheads to hover) and it
did `edgesDS.update(upd)` for the hovered node's edges. Even batched, that makes vis

- run `_updateVisibleIndices()` and `_updateValueRange()` over **all** nodes and edges,
- request a redraw, and
- fire the DataSet `'*'` event, which marks the **batched edge pass dirty** - so the next
  frame re-reads the formatting values and colours of **all 3 876 edges**.

That is a 100-300 ms stall per hover in a dense cluster, which is exactly "moving the mouse
over the centre is laggy".

Fix: write the arrow flag on the **edge instance** (`_setArrow`) instead of the DataSet, and
make the batch **skip arrowed edges at draw time** (`if (_arrowed(et)) continue;`) so the
cached groups stay valid and nothing has to be rebuilt. The arrowhead still appears (vis
draws that edge, arrow and all).

Alongside it, two smaller things on the hover path:

- the hover repaint is **coalesced to one per animation frame** (`scheduleHover` →
  `requestAnimationFrame(flushHover)`) instead of one per event behind a 70 ms / 140 ms
  debounce, so the focus lands on the next frame instead of ~100 ms later;
- the focus paint is a **delta**: moving from one node's neighbourhood to the next touches
  only the nodes that change, not all 1 886.

## Results

Hover sweep across 16 nodes in the dense centre (`harness/probe_zoom_interact.mjs`, worst
frame gap during the sweep):

| zoom | v16 (before) | v18 (after) |
|---|---|---|
| x16 | 195 ms | **76 ms** |
| x8 | 306 ms | **98 ms** |
| x4 | 215 ms | **63 ms** |
| fit | 214 ms | **104 ms** |

The median hover frame went from 21-63 ms to **7 ms** (one frame). The interleaved rest+hover
A/B (`results/ab-rest-L29.csv`, 5 rounds) puts the single-hover frame at x0.86 in favour of
the new build, with the resting frame inside the harness's own position bias.

Capability on v18: the arrowhead on a hovered edge still appears (45 px), the selected edge
restores to 0 px after deselect, the legend toggle still hides a community and its edges
(7 815 px, restored), and the at-rest edge parity is the same 10.3% (L12's ordering residual).

## Verdict

Ship the hover fixes. Do **not** ship the edge culling: it is the obvious idea and it does
not work, because the batch's stroke count was never the cost. If the dense-centre feel still
is not right, the next honest step is the *presentation* side (what the compositor does with
the frame after the draw), not more JavaScript in the draw path.
