# L34 — the lag hunt: a monitor for "where exactly does it stutter", and the cause it found

## The tool

`harness/probe_lag_hunt.mjs` - drives **random moves** around the graph (zoom in, zoom out,
drag-pan; random amounts, from wherever the camera happens to be) and records, per frame:

- the frame gap (the thing the eye sees),
- the camera (scale + world position) and how many nodes are near the view centre,
- the draw counter.

A sampling CPU profile runs over the same window, so a bad frame can be attributed to the
functions that were running in it. `harness/probe_click_latency.mjs` measures the click's
interaction-to-next-paint (the INP Chrome reports). `harness/probe_zoom_trace.mjs` adds the
sampling profile and the **redraw stacks** to one wheel gesture, which is what named the
culprit.

## What it found

The redraw stacks of a 14-notch wheel gesture in the dense core:

```
16x  vis emit -> the normal redraw
12x  vis Canvas.redraw -> _setLean -> lean -> (the zoom's 90 ms timer)   <-- a redraw INSIDE a redraw
```

**The lean was firing a full extra redraw after every zoom step**, plus a forced rewrite of
all 1 886 node instances (the lean used to change the disc's size, so it had to rewrite the
nodes when the gesture started and when it ended). Twelve extra complete frames per gesture,
and each of those frames is a full canvas raster at a deep zoom - which is exactly the
"clumsy in a dense area" the user reported.

But the lean had nothing left to lean: L30 removed the size change (the disc is drawn with
one fill in every state) and L32 removed the hover dim. It was pure overhead. **Removed.**

| | before (official) | ours before the fix (v23) | ours after (v24) |
|---|---|---|---|
| redraws per 14-notch gesture | 17 | **29** | **17** |
| our own JS in the gesture | - | 91 ms (`_arrowed` 42, `_nbApplyNode` 40) | 38 ms |

`_nbApply` (the per-frame pass over 1 886 nodes) now only runs when the **scale** changes,
which is the only thing its mode depends on (the ring state is applied by the hover/select
handlers directly).

## The fuzz, both builds, the same 36 random moves (seed 7)

| | official | ours (v24) |
|---|---|---|
| wall time for the 36 moves | 36.5 s | **17.1 s** |
| frame gap p50 | 20.6 ms | **7.0 ms** |
| frame gap p95 | 152.8 ms | **27.8 ms** |
| frame gap max | 423.5 ms | 284.6 ms |
| frames over 60 ms | **239** | **5** |

## The click (INP for a click), in the dense core at scale 5.3

| | official | ours |
|---|---|---|
| click -> painted frame p50 | 110.0 ms | **95.4 ms** |
| p95 | 206.4 ms | 228.1 ms |

Both are slow, and that is the floor: a click in a dense core repaints a canvas whose edges
are `2 * scale` px wide and hundreds of px long, and the presentation of that is the browser's
work, not ours. Ours is not worse; it is level.

## The measurements that had already ruled the draw out

- the synchronous draw at the same camera (the densest node, scale 3): **ours 7.3 ms, the
  official 45.6 ms**;
- the CPU profile of a wheel gesture: the official spends 1 125 ms inside vis's own
  per-edge drawing, ours 161 ms, and ours idles 1 148 ms waiting for the presentation.

## State

- artifact `variants/base-ours-v24.html` (`32a641d3`), view/after.html rebuilt and smoke-clean
- 43/43 tests
