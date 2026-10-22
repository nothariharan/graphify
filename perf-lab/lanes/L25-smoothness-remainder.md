# L25 — sleepy/sleek: what is left in the frame, and what is still visually rough

Lane owner: research sub-agent (smoothness / sleekness pass).
Scratch prefix for every file this lane creates: `L25_` (harness), `L25-` (results, shots).

## The brief

The build is good now (rest frame 26-29 ms, drag/pan/zoom 36-37 fps vs the official
15.4/15.4/6.6). The question is **where the next few wins are**, and what is still visually
rough. Five areas were named: the rest-frame remainder, the focus paint, the DOM around the
canvas, visual rough edges (LOD popping, tooltip, sidebar), and the drag path.

## Hypotheses, written before measuring

Ordered by what I expect to be worth doing, not by what is easiest to measure.

### H1 — the rest-frame floor is the edge curves, not the nodes (highest expected value)

L22 removed the node border; the node pass was 63 ms of 86 ms and is now a few ms. What is
left (26-29 ms) should be dominated by the **raster cost of 3 883 quadratic edge subpaths**
plus a full-canvas clear and present. If that is true, the frame is not "empty work" that can
be shaved by a smarter loop: it is the picture. The honest lever is **not drawing edges that
cannot be on screen** — viewport culling. At the fit scale nothing is culled (0 win, 0 risk),
but a user who zooms in to read a neighbourhood is looking at ~1/36 of the graph at 6x fit,
and the batch still strokes all 3 883 curves. Hypothesis: a culled edge batch makes the
zoomed-in rest frame and a zoomed-in pan **much** cheaper (target: >2x at scale >= 4x fit),
and is pixel-identical on the visible canvas because the culled edges are entirely outside
the viewport rect.

### H2 — the focus paint is cheap; the *redraw* is the cost; a delta paint saves little

The hover/click focus writes `options.color` on 1 886 node instances and then calls
`network.redraw()` (a full frame). Hypothesis: the paint loop is ~1-3 ms of a ~28 ms frame
(5-10%) and a delta paint (restore only the old keep set, dim only the new one) saves most of
that. So: a real but small win, and its real value is that it makes the paint cheap enough to
drop the **70 ms hover debounce**, which is a felt latency (the dim lands ~100 ms after the
pointer does), not a frame-rate win.

### H3 — the DOM around the canvas hides one real freeze: "Select All"

Hypothesis: the search box (a `RAW_NODES.filter` over 1 886 labels per keystroke) and vis's
tooltip (one DOM text write per hover) are cheap (<2 ms). The **Select All** checkbox is not:
`toggleAllCommunities()` calls `nodesDS.update()` on all 1 886 nodes (L13 measured a
`nodesDS.update` of 1 886 nodes at **149.6 ms**), and it does so even when the state does not
change (ticking "all" when all are already visible). One 150 ms freeze per click, on an
action the user may take to reset the view.

### H4 — the visual rough edges are mostly absent by construction, with two exceptions

Hypothesis: there is **no zoom-threshold LOD** to pop: only 66 of 1 886 nodes ship a label
(`font.size` 12 vs 0), decided at export time, and the disc size is a continuous function of
scale (`size + min(size, 1.5/scale)`), so neither the labels nor the dots have a threshold to
cross. Two things may still read as rough: (a) the **hover debounce** (70 ms on, 140 ms off)
makes the focus feel laggy and makes a quick sweep leave a stale dim for 140 ms; (b) the
sidebar is 141 rows plus a legend, and `#legend` has no height cap in the CSS - check whether
it scrolls as one 4 000 px column or has its own scroll area. Cheap screenshots answer both.

### H5 — the drag path redraws once per pointermove, which on a 60 Hz host is one per frame

Hypothesis: Chrome already coalesces pointermove to one per frame in a headless page, so
rAF-throttling the drag redraw buys nothing (a closed door). If pointermoves > frames, the
lever exists (one redraw per frame max); measure the ratio before building it.

## Method (instruments)

Every measured run holds the bench lock. Raw output goes to `results/L25-*.csv|txt`,
pictures to `shots/L25-*.png`.

| instrument | what it answers |
|---|---|
| `harness/L25_frame_parts.mjs` (new) | where the 26-29 ms goes: stubbed node shapes, edges on/off, a whole-canvas clear, and a per-op count/timing of the real frame (arc/fill/stroke/quadraticCurveTo/fillText) |
| `harness/L25_rest_ab.mjs` (new) | interleaved in-page A/B of **frame cost at a fixed camera**, alternating two configs every frame (needed for culling, where two builds at different cameras are not comparable) |
| `harness/L25_cull.mjs` (new) | injects a viewport-culled edge batch into the shipped build, then measures frame cost at fit / 2x / 4x / 8x fit and diffs the visible canvas against the un-culled frame (0-px control included) |
| `harness/L25_focus_paint.mjs` (new) | cost of `paint()` (full vs delta) and of the redraw that follows; time from `hoverNode` to the painted frame |
| `harness/L25_dom_costs.mjs` (new) | per-keystroke search cost, tooltip DOM write, sidebar build/scroll, Select All / legend toggle hitch |
| `harness/L25_drag_rate.mjs` (new) | pointermoves, drag events and redraws per second in a synthetic drag |
| `harness/ab_rest.mjs` (existing) | interleaved A/B of the shipped build vs a variant, through the lock, when a variant exists |
| `harness/probe_frame_parts.mjs`, `probe_node_time.mjs` (existing) | the L22 split re-run on v13, to know the starting point |

## Status

Measuring. Results, verdicts and the ranked list follow below.
