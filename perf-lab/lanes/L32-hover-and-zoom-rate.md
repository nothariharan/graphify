# L32 — hover must not dim, and why our zoom looked slower than the shipped one

## 1. Hover no longer dims anything

The user: "hovering alone should not make the other nodes go dim". The hover focus was an
L13 feature; the click focus (L24) is the one they asked for. Removed: `scheduleHover`,
`flushHover` and the hover paint. Hover now does only what it should - the arrowhead reveal
(direction on dense graphs), the tooltip and the cursor. Dimming is the click focus's job and
happens only on a click (verified: click 38 bright / 1 848 dimmed, empty space back to
1 886 / 0).

This also removes a real cost during a zoom: when the pointer sits over the graph and the
camera moves, nodes slide under the cursor, so `hoverNode`/`blurNode` fire repeatedly - and
every hover used to paint 1 886 node colours and force a full redraw. In a dense cluster that
is a constant background repaint *on top of* the zoom's own frames, and the graph visibly
dimmed as it moved. The shipped viewer has no hover dim, so it never paid any of this.

## 2. Why the zoom *felt* much laggier than the shipped version

Two measured causes, both now fixed:

**a. Our zoom went ~4x deeper in the same gesture.** vis multiplies the scale by 1.1 per
wheel event regardless of the delta. We took `e^(120 * 0.0016) = 1.21` per notch, so the same
14-notch gesture ended at scale **9.7** where the shipped viewer ends at **2.5**. At 9.7 the
visible edges are `2 world units x 9.7 = 19 px` wide and hundreds of px long: the canvas has
far more anti-aliased pixels to rasterize than the shipped viewer ever sees, because it stops
at 2.5. The zoom rate now matches vis's notch (`unit = 0.00079` for pixels, `0.0333` for
lines, `0.1` for pages) and the same gesture ends at **2.50**.

**b. The hover repaint during the zoom** (above).

## Results - the same wheel gesture, pointer over the dense centre

`harness/probe_zoom_gesture.mjs`, 14 real wheel events from scale 0.66:

| build | final scale | p50 | p95 | max | stalls >33 ms |
|---|---|---|---|---|---|
| official (before) | 2.51 | 7 ms | **76 ms** | 118 | **18** |
| ours, v22 (hover dim removed, old rate) | 9.73 | 7 ms | 14 ms | 63 | 4 |
| **ours, v23 (hover removed + vis's rate)** | **2.50** | 7 ms | **14 ms** | **49** | **2** |

At the same final zoom the shipped viewer stalls 18 times in the gesture and we stall twice;
its p95 frame is 76 ms, ours is 14 ms.

## State

- artifact `variants/base-ours-v23.html` (`ff99b4e8`), view/after.html rebuilt and smoke-clean
- capability: click focus 38/1848 and 1886/0 on dismiss, arrowhead on a hovered edge, legend
  toggle, selection restore - all unchanged
- 43/43 tests
