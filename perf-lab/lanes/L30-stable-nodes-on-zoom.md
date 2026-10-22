# L30 — the nodes were being resized on every zoom frame, and a click after a zoom was dropped

## Bug 1: clicking a node lit the whole graph

`setClick()` refused to run while `gestureActive()` was true. That gate was meant to keep a
click from fighting a *drag*, but the eased zoom keeps the lean on for ~180 ms after the last
wheel event, so a click that came right after a zoom was swallowed - the user clicked a node
and nothing dimmed. vis does not fire a `click` during a drag, so the gate is simply gone; a
real click is never a gesture.

Verified on the shipped build (`probe_click_focus.mjs`): click a node -> **38 bright / 1848
dimmed**, click empty space / the same node / Escape -> 1886 / 0, the white selection ring
intact.

## Bug 2: the dots changed size on every zoom frame

The node disc is drawn without vis's border stroke (L22), and the border it replaces is
`min(nodeWidth, 1.5/scale)` world units wide. The first fix reproduced that with
`size = base + min(base, 1.5/scale)` recomputed **on every zoom frame** - 1 886 size writes
per frame, each making vis re-resolve the node. That is the "the dots shrink and then sync
back" the user saw, and it was a per-frame hitch in the middle of the zoom.

The border only has two regimes, and they meet exactly:

- while `1.5/scale >= base` the border is capped at the node's own width, so the disc is
  exactly **twice the fill radius** -> draw it as one fill (`size = 2*base`, no border);
- once `1.5/scale < base` the border is thinner than the node -> **use vis's own border**
  (`size = base`, `borderWidth = 1.5`). At the boundary both draw the same radius, so the
  switch is seamless.

The mode is now computed per node and written **only when it changes** (`n.__nbSize` /
`n.__nbBw` guard). Zooming is then a pure camera transform for most of the range; a node
flips once, at its own threshold, and the shapes agree on both sides of it.

## Results

- Zoom gesture, interleaved 5 rounds (`results/ab-rsl-v18-v19-zoom.csv`): 35.6 -> **37.7 fps**
  (x1.06) with the stalled frames **24 -> 17** per 90. The visual shimmer is gone, which was
  the larger half of the complaint.
- Click focus: 38 bright / 1 848 dimmed, all three dismiss paths restore 1886 / 0.
- The synchronous draw stays where it was: 28.1 ms at the fit view (fill mode, no border
  strokes), 11.7-16 ms at 8x-24x (border mode, where vis culls most nodes anyway).
- 44/44 tests.
