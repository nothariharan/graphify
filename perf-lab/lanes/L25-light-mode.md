# L25 — light mode: the palette was built for a dark background

## The complaint

> "Light mode is quite fucked in this current scenario. The colours of the nodes are way too
> dark for the light mode to distinguish between them."

## The cause, measured

`harness/light_contrast.py` computes the WCAG contrast of every community colour against
both backgrounds:

| colour | on dark | on white | |
|---|---|---|---|
| #4E79A7 | 4.18 | 4.55 | ok |
| #F28E2B | 7.87 | **2.42** | too faint on white |
| #E15759 | 5.17 | 3.68 | ok |
| #76B7B2 | 8.32 | **2.29** | too faint on white |
| #59A14F | 6.01 | 3.16 | ok |
| #EDC948 | 11.82 | **1.61** | too faint on white |
| #B07AA1 | 5.57 | 3.42 | ok |
| #FF9DA7 | 9.64 | **1.98** | too faint on white |
| #9C755F | 4.64 | 4.10 | ok |
| #BAB0AC | 8.97 | **2.12** | too faint on white |

**Five of the ten community colours are below the 3:1 contrast ratio on white.** The palette
was drawn for `#0f0f1a`; on `#ffffff` the yellow, the pink, the teal, the orange and the grey
all sink into the page. That is the "cannot tell them apart".

Three more things were wrong in light mode and had the same root (a value that only makes
sense on a dark background):

- **The edges.** They inherit the community colour at 0.7 opacity, and 0.7 of a colour over
  white is 30% of that colour: the graph's structure was almost invisible
  (`shots/light-v13.png`).
- **The selection ring.** The focus/selection ring is `#ffffff` - white on white, so the
  selected node had no marker at all.
- **The dimming.** The focus blends the unconnected nodes 55% toward the background, which
  buries a node on white (its contrast drops to ~1.9:1) and leaves it loud on black.

## The fix

1. **A second palette** (`COMMUNITY_COLORS_LIGHT` in `graphify/exporters/base.py`): the same
   ten hues with the lightness walked down until every colour clears 4.6:1 on white, and they
   still clear 3.7:1 on the dark background (`harness/light_palette.py` generates it).
2. **The theme re-tints the canvas**, not just the CSS. The community colours, the edge
   colour, the selection ring and the dimming amount are all drawn into the canvas, so
   `applyTheme()` now calls `retint()`: instance writes (a DataSet update for 1886 nodes
   measured 149.6 ms), the edge batch is told to rebuild its groups, the legend swatches,
   the search swatches and the neighbour swatches follow the palette, and the focus block
   re-captures its base colours so a dismiss restores the *new* palette.
3. **The edges** get a theme colour and a theme opacity (`--edge-color`, `--edge-opacity`:
   0.7 dark, 0.92 light) - at 0.7 over white they were 30% of the colour.
4. **The selection ring** is a theme value (`--node-ring`: white on dark, `#1f2430` on light).
5. **The dimming amount** is a theme value (`--dim`: 0.55 dark, 0.42 light).
6. The theme switch no longer updates all 1886 nodes' fonts: only the labelled ones (the
   high-degree ones) are updated, which removes a 149.6 ms hitch from every theme switch.

## Evidence

| | before (v13) | after (v14) |
|---|---|---|
| community colours below 3:1 on white | 5 of 10 | **0 of 10** (all >= 4.6:1) |
| the same colours on the dark background | >= 4.18 | >= 3.73 |
| edge contrast on white | ~1.3:1 (invisible) | visible (`--edge-opacity: 0.92`) |
| selection ring on white | invisible (white on white) | `#1f2430` |
| dimmed node on white | ~1.9:1 | ~2.1:1 and less bleached |

Screenshots: `shots/light-v13.png` (before), `shots/light-v14b.png` (after, resting),
`shots/light-v14-focus.png` (after, with a click focus - the focused node has a dark ring
and the 37 connected nodes are at full colour).

The click focus in light mode: 38 bright / 1848 dimmed after the click, 1886 / 0 after any
dismiss path (`probe_click_focus.mjs --theme light`) - the same contract as the dark theme.

Tests: 40/40 in `tests/test_html_perf_levers.py`, including a guard that computes the
contrast of every palette entry, so a future palette change cannot silently make the light
theme unreadable again.



## Reversed: the palette stays the original (the user's call)

The darkened light-theme palette was measured, shipped, and then rejected on sight: on white
the original colours are the ones that read right, even though five of them are below the
3:1 threshold (a 1-2 px dot at 1.6:1 is still a dot you can see; a darkened dot is a dot you
do not want to look at). The palette is now **one palette for both themes** again, and what
stays theme-specific is everything that was actually broken on white:

- the edge colour and opacity (--edge-color, --edge-opacity: 0.7 dark, 0.92 light),
- the selection/focus ring (--node-ring: white on dark, #1f2430 on light - it used to be
  white on white),
- the dimming amount (--dim: 0.55 dark, 0.42 light),
- and the retint machinery, which still restores the palette after a data change and keeps
  the legend, the search swatches and the neighbour links on the same palette.

shots/light-v16.png is the picture: the original bright palette on white, with the panel.

## Verdict

Ship it. The light theme was never a theme, it was the dark theme's colours on a white
background; now it has its own palette, its own edge treatment, its own ring and its own
dimming, all of them measured rather than eyeballed.
