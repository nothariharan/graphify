# L11 — viewer experience (focus, fly-to, HUD, legend)

## Hypothesis

The gesture lever is largely done (82fps on rsl); the remaining gap between
"fast" and "a graph I would love to use" is interaction: locating a node in 1886,
understanding its neighbourhood, seeing whether the view is actually smooth, and
taming the 141-community legend. Four features, all capability-preserving (they
fade or isolate on demand and restore on background click — nothing is deleted):

1. **Click-to-focus**: fade everything outside the 2-hop neighbourhood.
2. **Search fly-to + pulse**: Enter on a search hit pans/zooms to the node and pulses it.
3. **fps / frame-time HUD** (toggle with `H`): makes smoothness visible instead of felt.
4. **Legend isolate + hide-leaves**: double-click a legend swatch to isolate a community;
   a button hides degree-1 "hairball" nodes.

## Implementation

`perf-lab/harness/mk_l11.py` builds `variants/L11-ux.html` from the shipped v7
artifact by injecting a self-contained `<script id="l11-ux">` before `</body>`.
No change to the exporter or to vis's draw path; everything is done through
`nodesDS.update` / `edgesDS.update` and `network.focus`.

- Focus: 2-hop set via `network.getConnectedNodes` (twice); non-members get
  `opacity: 0.12` (nodes) and edge `color.opacity: 0.06`; background click restores.
- Fly-to: `network.focus(target, { scale: 1.4, animation })` + a size pulse (1.8x for
  600ms).
- HUD: an rAF loop reporting `fps` and `frame:` ms, toggled with `H`.
- Hide-leaves: toggles `hidden` on degree-1 nodes.
- Legend isolate: double-click a `.legend-swatch` (data-cid) fades the rest.

## Measurement

Interleaved A/B, 3 rounds, rsl (bench-locked, `results/ab-L11-focus.csv`):

| gesture | before (v7) | L11-ux | ratio | jank>33 before -> ux |
|---|---|---|---|---|
| node | 39.5 | 39.7 | x1.01 | 17 -> 17 |
| pan  | 34.2 | 33.7 | x0.99 | 21 -> 22 |
| zoom | 33.1 | 35.4 | x1.07 | 31 -> 20 |

The UX additions do not regress the gesture numbers (within noise; zoom's jank drops
from 31 to 20). The idle cost of the HUD's rAF loop and the focus restore paths are
not measurable against the gesture floor.

## Smoke test

`harness/smoke_view.mjs --file variants/L11-ux.html`: 1886 nodes / 3876 edges /
1886 drawn, physics off, lean on, no JS errors (only the expected favicon 404).

## Verdict

Adopt all four, as a single UX block (they share the focus/restore machinery and the
legend container). None of them changes what is drawn during a gesture unless the
user asks for it, so the in-motion pixel parity (1.1-1.8%) from L8 tick 3 is
unaffected. The HUD directly answers the user's "I don't feel a difference"
complaint by making the frame time visible.

## Open judgement calls (for the user)

- Default state of the HUD: off (toggle with `H`). Could default on for a demo build.
- Focus on a *single* click may surprise users who expect click-to-inspect (the
  sidebar already does inspect). Consider requiring a modifier (Shift+click) or a
  dedicated "focus" button in the info panel.
- Hide-leaves threshold is degree <= 1; could be degree <= 2 for a denser graph.

## Evidence

- `variants/L11-ux.html` (1.86 MB) — the prototype.
- `harness/mk_l11.py` — generator (injects the UX block before `</body>`).
- `results/ab-L11-focus.csv` — interleaved 3-round A/B.
- No exporter patch yet: this lane is JS/CSS only and touches no draw path, so the
  patch is the injected block (see `mk_l11.py`). The loop owner can fold it into
  `_html_script` as a new `{_UX_JS if ...}` interpolation alongside
  `_LEAN_GESTURE_JS` / `_POSITION_CACHE_JS`.

## Regression test

Proposed: a smoke check that clicking a node sets non-neighbour opacity < 1 and that
a background click restores all opacities to 1; plus the existing 20 tests green
on the unmodified exporter.