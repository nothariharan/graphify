# Lane L3 — edge rendering (arrows / dashes / smooth)

Owner: subagent (deepseek-v4.1-flash-free). Primary metric: redraw_min; secondary pan/zoom_fps.

## Brief
Arrows are 3876/3876 edges, `{to:{enabled:true,scaleFactor:0.5}}` (html.py L186).
Measured on rsl dpr1 (redraw_min, baseline 21.1):
- v13 arrows-on-hover: **7.6 (-64%)** — direction shown on hover, capability kept.
- v02 no-arrows (global): 7.4 (-65%) — loses direction.
- v14 vee / v15 bar / v16 circle: 21.2 / 21.7 / 23.1 — type is not the lever.
- v04 straight: 13.6 (-36%); v18 discrete: 19.7 (-13%); v03 no-dash: 21.7 (~0).
Capability at stake: direction (arrows) and confidence (dashes). Direction must remain
discoverable; dash removal must be offset by another confidence cue if it ever matters.

## Steps
1. Replicate v13 with repeat 3, aggregate redraw_min. Certify -64%.
2. Try deferred arrows also on selectNode/selectEdge (click), not just hover.
3. Consider hybrid: arrows on for edges above a degree/zoom threshold, hover otherwise.
4. Only pursue dashes/straight if a GPU/DPR where they matter is found (none yet).

## Status
CERTIFIED (4 tiers) and SHIPPED. arrows-on-hover: rsl x0.36 (reps=4, dpr1+dpr2),
rsl same-session x0.30, continuum 9142 x0.33, gsoc aggregate 2290/8045 x0.37
(v21 straight+hover x0.33). Arrow type is not a lever. Dashes ~0.
Shipped as a density gate (`ARROW_DEFER_EDGE_THRESHOLD=1500`) with ref-counted hover reveal
on edge hover and node hover (all incident edges). Deferred-on-select was not needed:
hover already keeps direction discoverable, and the gate keeps small graphs unchanged.
