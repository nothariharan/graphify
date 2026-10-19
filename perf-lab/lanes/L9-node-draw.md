# L9 — node draw is now the floor (investigated 2026-10-19)

## Hypothesis

After the edge pass was batched (L8, tick 3) the per-frame cost on rsl (1886 nodes /
3876 edges) split roughly as: 20 strokes for the edges, 0 strokes for the node borders
(lean is on during a gesture), and the rest is the **node pass** — `initContextForDraw`
(3 property sets) + `arc` + `fill` + `save`/`restore` per node, ~18 ms of a ~45 ms
resting frame and most of the ~12 ms gesture frame. Three ways to make it cheaper were
on the table:

1. **Group node fills by (fill colour, radius)** — one `beginPath()` + one `arc` per node
   but one `fill()` per group, the same trick that took edges from 3876 strokes to 20.
2. **Drop the node shadow during a gesture only**, restoring on release.
3. **Render the node pass at a lower DPR while a gesture is live.**

## What the probes found

- **Shadow is already off.** `options.shadow` is `{}` for every one of the 1886 nodes, and
  `getFormattingValues()` resolves that to `shadow: false`, so `enableShadow()` skips.
  Hypothesis (2) is a no-op on the default graph — there is nothing to drop.
- **DPR is already known not to matter.** Phase 2 measured `dpr2` (4x the pixels) at
  23.0 ms vs `dpr1` at 22.5 ms — CPU geometry-bound, not fill-bound. Hypothesis (3) is
  rejected by that prior evidence and was not re-measured.
- **Grouping does not collapse far enough.** `probe_nodes.mjs` on the shipped build reports
  1886 nodes but **208 distinct (colour, radius) pairs** (10 colours x ~50 radii, sizes
  ranging 10.0..40.0). Grouping by (colour, radius) would take `fill()` calls from 1886 to
  208 (a 9x reduction in call count) and `save`/`restore` from 1886 to 208, but the `arc`
  count stays at 1886 — the geometry is untouched. Whether 9x fewer `fill()` calls moves a
  ~12-45 ms frame is doubtful given the "geometry-bound, not fill-bound" finding, and the
  benefit is much smaller than the edge batch's 194x (3876 -> 20).
- **There is no clean seam.** The edge batch works because vis calls one method per edge
  (`edgeType.drawLine(ctx, ...)`) that does the whole edge. A node is drawn by
  `shape.draw`, which interleaves `initContextForDraw`, the path (`_A`), `performFill`
  (fill + shadow + border stroke + save/restore) and `updateBoundingBox` + the label. There
  is no single "drawNodeFill" to take over without reimplementing the node draw, which
  would break hover, selection, labels and hit-testing. The edge batch's fallback-on-throw
  and uninstall-after-2-errors machinery (D37) exists precisely because taking over a draw
  path is fragile; doing it for the whole node is an order of magnitude riskier.

Per-frame ops measured during a drag on the shipped build (20 frames): `arc 2640`, `fill 2642`,
`stroke 2899`, `beginPath 4600` per frame — i.e. already lean once the border is off.

## Verdict: no adoptable lever in this lane

L9 closes without a shipped change. The node pass is the floor, but the realistic levers
(shadow, DPR) are already off / already disproven, and the remaining one (fill grouping)
lacks a safe seam in vis's node draw and would save call overhead on a geometry-bound path.
I am deliberately not shipping a risky reimplementation of `shape.draw`.

## What I would try instead (not in this lane)

- **L12 (proposed) — keep the edge batch installed at rest too**, handling hover/selection
  by re-drawing the hovered/selected edge on top in its own style. The resting frame is
  5762 strokes (1886 borders + 3876 edges); the batch would take that to ~1906, which is
  the biggest remaining single-frame win and directly addresses the release hitch at the
  end of a drag. It is a larger, riskier change than L9 and needs its own lane + parity
  proof, because at rest per-edge hover highlighting must survive.
- **L10 (instant first open)** and **L11 (viewer experience)** are higher-value and have
  cleaner seams; they run next.

## Evidence

- `harness/probe_nodes.mjs` (new) — distinct-pair count + per-frame op tally.
- `harness/_shadow.mjs`, `_shadow2.mjs`, `_shadow3.mjs` (scratch) — shadow is off in values.
- Phase 2 DPR finding (STATE.md Findings) — DPR is not a factor.
- No new CSV: no variant was built, because no lever had a safe seam to measure.

## Regression test

None added. The shipped levers are already covered by `tests/test_html_perf_levers.py`
(20 tests). L9 changes nothing in the exporter.