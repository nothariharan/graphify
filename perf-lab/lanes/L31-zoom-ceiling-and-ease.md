# L31 — the zoom ceiling, the trailing ease, and the shrinking dots

Three separate things were behind "zooming is still laggy and limited".

## 1. The zoom ceiling was ours, not vis's

vis's own wheel handler clamps the scale to `[1e-5, 10]` (`zoom()` in the pinned bundle).
The eased zoom clamped the zoomed-in end to `fit * 12`, which on rsl is **0.99** - a tenth
of what the shipped viewer allows. That is the limit the user hit. The ceiling is now **10**
(vis's own) and only the zoomed-out end keeps a floor (`fit/6`), so the graph cannot be lost
in the distance.

## 2. The trailing ease read as lag

The eased zoom approached its target with a `0.25` factor per frame - about 40 ms of trail
behind the wheel. Measured against the official build in a wheel gesture from a deep start
(`harness/probe_zoom_gesture.mjs`, 14 real wheel events from scale 0.66):

| | p50 | p95 | max | stalls >33 ms |
|---|---|---|---|---|
| official | 7 ms | 28 ms | 70 ms | 6 |
| ours, before | 7 ms | 21 ms | 49 ms | 3 |
| **ours, now** | **7 ms** | **7 ms** | **42 ms** | **2** |

The coalescing is what the easing was protecting against - **one `moveTo` and one redraw per
animation frame, however many wheel events arrive** - so the graph can now land on the
target in the frame it is applied. p95 = p50 = one frame, and ours reaches scale 9.7 where
the official stops at 2.5 (its per-event factor is 1.1, ours accumulates the wheel delta).

## 3. The nodes shrank whenever the graph moved

The lean shrank the disc to the fill radius for the length of a gesture, because the small
discs raster faster. That is exactly the "every node gets smaller when I move or zoom" the
user saw (their two screenshots are the same view at rest and mid-gesture). The size is now
the same in a gesture as at rest; the lean only suppresses the hover paint, which is all it
should have been doing. The cost is a slower drag/zoom than the shrunken-disc version, and
that is the trade the user asked for: the picture must not change while you move it.

## State

- artifacts: `variants/base-ours-v20.html` (`527f849f`), view/after.html rebuilt and smoke-clean
- capability on v20: arrowhead on a hovered edge (45 px), selected edge 183 px and 0 after
  deselect, click focus 38 bright / 1848 dimmed
- 44/44 tests
