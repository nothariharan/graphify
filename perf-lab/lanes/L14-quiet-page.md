# L14 — the page should be quiet when nothing happens

## Hypothesis

A graph viewer that redraws while the user is reading is wasting CPU: fans spin, laptops get
warm, and battery drains for a picture that is not changing. Before spending on faster frames,
check whether the resting page draws *at all*.

The exporter has several things that could keep a frame loop alive: the frame HUD (off by
default), the eased-zoom rAF pump (`_zoomTick`), the lean/zoom idle timer, the position-save
debounce, and vis's own `redraw` requests. If any of them runs when the pointer is still, the
idle cost is not 80 ms per redraw, it is 80 ms times however often it fires.

Measured question: **how many canvas draws happen in 3 seconds with no input, after the scene
has settled?**

## Method

`harness/probe_idle.mjs` (same server + settle procedure as the other probes):

1. Load the artifact, wait for physics off, let it settle past the known 3rd-draw pass.
2. Hook `network.on('afterDrawing')` and count. Hook `ctx.stroke`/`fill` for per-draw work.
3. Wait 3000 ms with no pointer/keyboard events.
4. Report draws, strokes, fills, and the gap distribution between draws.
5. Then emit one `hoverNode` and one blur, and count draws again at rest.

Also reports `_frameTick` state if the HUD loop is reachable, and whether `requestAnimationFrame`
keeps firing (a frame loop that draws nothing is cheap but still wakes the CPU; report it,
do not conflate it with draws).

## Bar

- 0 draws in 3 idle seconds on the settled page.
- A hover enter/leave must not leave a loop running afterwards (0 draws in the 2 s after the
  pointer settles).

## Results

`probe_idle.mjs` on `variants/base-ours-v10.html` (before the fix):

```
idle 3001 ms: draws=0 strokes=0 fills=0 rAF=432 redraw calls=0
after hover in+out, next idle window: draws=0 strokes=0 fills=0 rAF=432 redraw calls=0
```

The page does not draw when nothing happens (0 draws, 0 redraw requests) - good. But it
wakes up **432 times in 3 seconds** (144 Hz): the frame HUD's rAF loop ran for the life of
the page whether or not the HUD was visible, so a page nobody was looking at kept the
compositor and the CPU awake.

The fix: the HUD loop starts when the HUD is turned on and stops when it is turned off.

`probe_idle.mjs` on `variants/base-ours-v10.html` (after the fix, `base-ours-v11.html`
carries it):

```
idle 3013 ms: draws=0 strokes=0 fills=0 rAF=0 redraw calls=0
after hover in+out, next idle window: draws=0 strokes=0 fills=0 rAF=0 redraw calls=0
```

## Verdict

Ship it: an idle page now costs nothing at all (0 rAF, 0 draws). It does not move a frame
rate - nothing was moving - but it stops a laptop from spinning up a core to show a
picture that is not changing, and it is the difference between "the viewer is running" and
"the viewer is idle".

