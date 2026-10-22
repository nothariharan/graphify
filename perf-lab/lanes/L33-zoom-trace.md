# L33 — trace: why does a dense deep zoom feel slower than the shipped viewer?

No fixes in this lane. Only the trace, and the list of candidates ranked by the evidence.

## Measurement 1 — the draw at the SAME camera (the decisive one)

`harness/probe_deep_split.mjs`, both builds moved to the densest node at scale 3, timing
`network.body.emitter.emit('_redraw')` directly (the frame interval is vsync-quantised):

| build | visible | sync draw |
|---|---|---|
| official v8 | 11 nodes / 72 edges | **45.6 ms** |
| ours v23 | 11 nodes / 72 edges | **7.3 ms** |

Ours is **6x faster** at the same camera, and its parts are all cheaper (batch off 21.8,
nodes off 12.2, labels off 5.8). So **the canvas drawing is not the cause** - in fact the
official's draw at a deep dense zoom is terrible (45-73 ms), because it strokes all 3 876
edges individually and every edge is `2 * scale` px wide and hundreds of px long.

This is the single most important line in the trace: whatever the user feels, it is not the
draw.

## Measurement 2 — the work per wheel gesture

`harness/probe_gesture_work.mjs`, 14 wheel notches in the dense centre, counting redraws and
timing the wheel -> next-frame work:

| build | final scale | redraws | per event | wheel->frame JS |
|---|---|---|---|---|
| official v8 | 2.514 | 20 | 1.43 | 5 ms total (0.4/event) |
| ours v23 | 2.496 | 28 | 2.00 | 32 ms total (2.3/event) |

Ours does **40% more redraws** and **6x more JavaScript per wheel event**. In absolute terms
that is 32 ms across the whole gesture - small, but it is the only measured difference left
in the event path, so it is where the remaining candidates live.

## Candidates, with what the evidence says

**1. Two redraws per wheel event (measured: 2.0 vs 1.43).** Where the second one comes from
is not yet identified. The obvious suspect - the arrowhead reveal firing on every node that
slides under the pointer - was **tested and eliminated**: stubbing `_syncArrows` in the page
changed nothing (27 redraws, 2.5 ms/event). Next step: instrument the wheel handler's parts
(`moveTo` vs the `zoom` event's lean path) and the `afterDrawing` stack.

**2. `_nbApply` runs over all 1 886 nodes on every frame** (a mode check per node; it only
*writes* on a crossing). ~0.3-0.5 ms per frame by estimate, not yet isolated. Next step: time
it directly on a forced draw.

**3. The lean's forced pass at the zoom start and end** (`_nbApply(true)` -> 1 886 writes,
plus a redraw on release). A one-time hitch per gesture, not a sustained cost. Next step:
count the frames over 33 ms at the start/end of a gesture.

**4. The zoom *granularity*, not the frame cost.** Ours applies the accumulated target once
per animation frame; vis applies it once per event. At a fast wheel rate ours can show a
*larger jump per frame* with *fewer frames* than vis - the same total motion delivered in
coarser steps, which reads as jerky even when every frame is fast. Not measured; a perceptual
candidate that would explain "the before feels smoother" with ours drawing 6x faster.

**5. Different zoom levels being compared (already identified and fixed).** Before L31/L32 the
same gesture ended at scale 9.7 for us and 2.5 for the official, and before L31 our ceiling
was 0.99 - so "the same density location" was not the same zoom: ours was showing far more
nodes and edges per screen. That is now matched (final scale 2.50 vs 2.51).

**6. The presentation/raster at deep zoom.** The canvas raster grows with the zoom (thick,
screen-long edges). But the official pays *more* of this, not less (measurement 1), so it
cannot explain the official feeling smoother.

## Ruled out

- the canvas draw (6x faster in ours at the same camera)
- the arrowhead reveal during a zoom (stubbing it changes nothing)
- the hover dim during a zoom (removed in L32)
- the zoom rate and the ceiling (matched in L31/L32)

## What the trace says to do next

Instrument the *event -> first painted frame* path, not the frame cost: where the second
redraw per event comes from, what `moveTo` costs per frame, and whether the per-frame step is
larger than vis's per-event step at the same wheel rate. If the numbers stay this one-sided,
the remaining difference is granularity (candidate 4), not work.
