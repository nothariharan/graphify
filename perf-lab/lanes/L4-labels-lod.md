# Lane L4 — labels / text LOD

Owner: subagent (deepseek-v4.1-flash-free). Primary metric: redraw_min.

## Brief
Baseline labels only 66/1886 nodes (high-degree threshold). Measured: removing all labels
(v06) 22.0 vs baseline 21.1 (~0%); LOD keep-top-8% (v07) 21.8 (~0%). Text is not a
bottleneck at this tier. Capability at stake: node identity in the view.

## Steps
1. Confirm on continuum (9142): do labels start to cost once many are in view?
2. If yes, ship LOD (label on hover/zoom) — already how the shipped view behaves.
3. Otherwise close the lane as no-win and record.

## Status
Open, low priority. Expected outcome: no-op at rsl tier.
