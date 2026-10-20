# L13 — interaction feel (eased zoom, hover focus, colour-preserving selection)

## The report

Two complaints on the build that followed L11:

1. "zoom freezes the graph" — the camera jumps and the page hangs mid-wheel.
2. "node colours go dim" — after interacting, the graph looks washed out and stays
   that way.

## Root cause (both real, both measured)

**Dimming.** The L11 prototype's click-to-focus wrote `opacity: 0.12` onto every
non-neighbour node through `nodesDS.update` and only restored on a background click.
One click on a dense cluster left **1858 of 1886 nodes** dimmed with nothing on
screen saying why. Probe on `variants/L11-ux.html`: `dimmed: 1858` after a single
click. This is a prototype bug, not a rendering limit — `view/after.html` at v7 has
`dimmed: 0` and full community colour after a click and after a zoom.

**Zoom.** vis zooms once per wheel *event* and each event is a full synchronous
redraw. A trackpad fires dozens per frame. Measured on rsl over one wheel battery:
**24 long tasks / 2369 ms**, `zoom_fps` 18.4.

## What shipped

`_UX_JS` in `graphify/exporters/html.py`, gated on `lean_gestures` (>800 nodes), so
small graphs stay byte-identical.

1. **Eased, cursor-anchored zoom.** Wheel events accumulate a target scale; a rAF
   loop approaches it (25% of the remaining log distance per frame) and holds the
   world point under the cursor fixed. One redraw per frame instead of one per event.
   vis's own wheel handler is bypassed (`stopPropagation` + capture listener).
   Range is derived *after* the fit on first wheel — `fit/6 … min(2.0, fit*12)` — so
   labels cannot be blown up without limit. `network.moveTo(..., animation:false)`
   emits no `zoom`/`pan` in vis 9.1.6 (measured: 2 calls → 0 events), so the lean draw
   is driven explicitly around the animation.
2. **Hover focus, Obsidian style.** Hovered node plus 1-hop neighbours keep their
   community colour; the rest blend 55% toward `--bg`. Restored on blur, never on
   click. Painting mutates `n.options.color` on the instances and issues one redraw;
   `nodesDS.update` of 1886 nodes measured **149.6 ms** and is exactly the hitch this
   avoids. `n.options.opacity` is ignored by the draw, so it is not used at all.
3. **Selection keeps the community colour.** The node colour dict shipped
   `highlight.background: "#ffffff"`, so a selected/hovered cluster turned white.
   Now `highlight`/`hover` keep the same background and accent with a white border
   ring. The learning-status override had the same white highlight and now keeps its
   status ring instead.
4. **Frame HUD on `H`** (textContent only; the L11 version appended a DOM node every
   frame).

## Measurements (bench-locked, interleaved, odd rounds)

First-open load, rsl 1886/3876, cold context per variant, 5 rounds
(`results/ab-load-L13.csv`, medians):

| variant | median ready (ms) | ratio to it200 | note |
|---|---|---|---|
| it200 (shipped default) | 9907 | — | solver 200 |
| it60 | 5030 | x0.51 | |
| it30 | 1901 | x0.19 | **rejected on look** — hairball, no community structure (`shots/fit-30.png`) |
| nolayout (improvedLayout:false) | 9547 | x0.96 | no win |
| baked (physics off + x/y) | 1259 | x0.13 | **the real win**, needs a build-time browser step |

Zoom health on the shipped artifact (`results/L13-zoomhealth-v8.txt`, view/after.html):

| | p50 | p95 | max | >33ms | >250ms |
|---|---|---|---|---|---|
| zoom in, 14 wheel steps | 16.9 | 29.1 | 105.7 | 3/98 | 0 |
| zoom out | 21.8 | 30.8 | 39.6 | 4/86 | 0 |

Mid-zoom: `lean: true`, batch installed on all 3876 edges, `white: 0`, `dimmed: 0`.
Hover: `dimColor` 1884 while hovered, **0** after blur. L11 for comparison: p95
36–62 ms, max 209 ms, `dimmed: 1858` stuck after one click.

Same-session `measure.mjs` A/B, v7 vs v8 (single run, so read the ratio not the fps):
zoom 18.4 fps / 24 long tasks / 2369 ms → **46 fps / 3 long tasks / 169 ms**. Pan is
unchanged (~10 fps in that run) — pan is node-drag floor, not this lane.

## A bug found while porting

Commit `716c421e` (L10) turned the stabilization handler into a Python string
containing a literal backslash-n:

```
"network.once('stabilizationIterationsDone', () => {\\n"
```

so the emitted page contained `…() => {\n` and **the whole main script died on a
parse error**. Every artifact built from that commit renders no graph at all. The
ported v8 build failed the smoke test with `Invalid or unexpected token` /
`network is not defined`; the handler is now emitted as one line. Regression test:
`test_stabilization_handler_is_valid_js`.

## How hover is verified (and why the probe fakes the event)

Playwright's synthetic mouse does not make vis emit `hoverNode` in headless Chrome:
the move arrives (vis's own tooltip shows the node's label) but no `hoverNode`. The
**HEAD baseline behaves identically**, so it is an instrument limit, not a page bug.
`probe_zoom_health.mjs` therefore tries the real pointer first and falls back to
`network.emit('hoverNode')`, reporting `hoverVia`. What that proves is the part that
was broken: the colour math, that nothing else is dimmed, and that blur restores to 0.
A synthetic event cannot prove vis's own hover detection — that is unchanged code.

## Verdict

Adopt. Zoom no longer queues a redraw per wheel event and no longer leaves the lean
draw or a dimmed graph behind; selection no longer repaints nodes white. Capability is
untouched: 1886 nodes / 3876 edges / 141 communities / arrowheads / dashed confidence
all still draw, and the lean/edge batch still turns itself off on release.

## Evidence

- `graphify/exporters/html.py` — `_UX_JS`, the `{_UX_JS if lean_gestures else ''}`
  injection, the node colour dict, and the stabilization-handler fix.
- `variants/base-ours-v8.html` → `view/after.html` (rebuilt, smoke clean).
- `results/L13-zoomhealth-v8.txt`, `results/L13-probe.csv`, `results/ab-load-L13.csv`.
- `harness/probe_zoom_health.mjs`, `harness/probe_zoom_cost.mjs`,
  `harness/probe_colorwrite.mjs`, `harness/ab_load.mjs`, `harness/mk_load_variants.py`,
  `harness/mk_v8.py`.
- `shots/zoomhealth-shipped.png`, `shots/zoomhealth-l11.png`, `shots/fit-30.png`.
- `tests/test_html_perf_levers.py` — 27 tests green (7 new for this lane).

## Open

- Wire a `--bake` step so first open is x0.13 instead of x1.0. Needs a headless
  browser at export time; the exporter already consumes x/y when present (L10).
- Pan is still the worst gesture (~10 fps in a bad session); it is node-drag cost,
  which L9 closed with no lever.
