# L12 — keep the edge batch on at rest

## Hypothesis

The gesture levers (border lean + batched edge pass) only exist while a gesture is live.
At rest, rsl issues **5762 strokes per frame** — 1886 node borders plus one stroke per edge
(3876). Everything the user does that is not a drag is a full redraw of that same frame:
hover focus paints 1886 node colours and calls `network.redraw()`, a selection redraws, a
legend toggle redraws, and the idle frame is what the next gesture starts from.

The batch already draws every edge — same colour, same dashes, same width, same curve — in
about 20 strokes instead of 3876. It is removed on release only because nobody had measured
whether it is safe to keep. Hypothesis: install it for the whole session on dense graphs and
resting/hover/selection frames get materially cheaper, with no visible change.

Risk that has to be closed before shipping:
- **Selection/hover must still look selected/hovered.** vis passes `sel`/`hov` per edge.
- **Arrowheads must still appear.** Dense graphs defer arrowheads to hover; an edge that is
  currently showing its arrow cannot be drawn by the batch (it draws lines, not arrowheads).
- **Hidden nodes / legend toggles must take effect.** The batch caches its groups, so a data
  change has to invalidate that cache.

## Method

Scratch variant `variants/L12-rest-batch.html` built from `base-ours-v8.html` by
`harness/mk_l12.py` (exporter untouched until it wins):

1. The patched `drawLine` is installed once, after load, and never removed.
2. `sel || hov || arrow-enabled` edges fall through to vis's own implementation.
3. `nodesDS`/`edgesDS` `'*'` events set a dirty flag; the next frame rebuilds the groups.

Instruments:
- `harness/ab_rest.mjs` — interleaved, odd rounds: forces one redraw per rAF for 60 frames
  and reports the median/p95 frame interval, then times a hover focus cycle. Same host
  drift rules as `ab_drag.mjs`.
- `harness/probe_rest_pixels.mjs` — same camera, batch on vs batch removed, pixel diff. The
  bar is the same 2% of painted pixels used for in-motion parity.

## Acceptance

- resting frame interval improves on rsl, paired ratio reported with stalls (>33 ms)
- pixel diff under 2% of painted pixels
- hover dim/restore still works, selection still draws highlighted, arrowheads still appear
  on hover (checked on the rsl artifact and on a sparse 900-node graph)

## Results

### Parity — the batch changes stroke order, and that is the whole diff

`probe_rest_pixels.mjs` (rsl, same camera, batch ON vs `setRest(false)`):

| build | painted (batch) | painted (vis) | differing | only-batch | only-plain | of painted |
|---|---|---|---|---|---|---|
| L12 scratch | 143 767 | 143 763 | 14 686 | 927 | 923 | **10.22%** |
| L12 scratch, every edge solid (`--nodash 1`) | — | — | 2 319 | — | — | 1.61% |

The two frames cover the same pixels (±4 px of 143 k) and differ only in colour: the
difference is *which translucent edge wins where two edges cross*. Grouping by colour draws
all edges of one community together; vis draws them in insertion order, so at a crossing the
other stroke is on top. In a dense hairball most painted pixels sit on or next to a crossing,
which is why the number is 10% and not 2%.

Visual check, busiest 250x200 crop (`shots/L12-settled-{plain,batch,mask}.png`): the two
frames are indistinguishable to the eye, the mask is a dusting along edges.

The earlier 1.74% reading came from capturing the vis frame two rAFs after `setRest(false)`,
and from the nodash control after a full `edgesDS.update` (which re-creates edge instances and
reshuffles insertion order, which happens to land closer to colour order). Neither is the
frame a user sees on a fresh open. The `--nodash` 1.61% is the honest number for "same order,
same colour" and it says the geometry, width and colour are exact; the 10.2% is purely
ordering.

That also retracts the old `setLineDash` trap: the dash pattern restarts at every subpath, so
grouping does *not* shift dash phase. Dashed edges are still handed back to vis
(`e.edgeType.__leanDash`) because there are only 393 of them on rsl and confidence texture is
not worth approximating — 3 483 edges remain batched.

### Capability (v9, `probe_capabilities.mjs`, settled baseline)

| check | result |
|---|---|
| arrowhead on a hovered edge | `enabled=true`, instance is batched, 103 px change → arrow appears |
| selection | 172 px changed, **0** px still different after deselect |
| legend toggle (hide community 0, 87 nodes) | 7 945 px change; batch vs vis on that frame 13 766 px (9.77%, only-batch 933 / only-plain 940 — again order, not coverage) |
| restore | 0 px different vs the settled frame |
| hidden community's edges | now follow vis's rule: an edge needs **both** endpoints visible (`Body._updateVisibleIndices`). Without that fix the batch kept painting 364 orphan edges (verified: 9 191 px vs 931 px on the toggle). |

### Timing (`results/ab-rest-L12.csv`, 3 interleaved rounds, one forced redraw per rAF)

rest frame interval, p50 ms (lower is better):

| round | v8 (no rest batch) | v9 (batch at rest) | ratio |
|---|---|---|---|
| 1 | 85.0 | 69.9 | 0.82 |
| 2 | 84.2 | 82.8 | 0.98 |
| 3 | 106.2 | 79.9 | 0.75 |
| **median** | **85.0** | **79.9** | **x0.94** |

hover cycle, p50 ms:

| round | v8 | v9 | ratio |
|---|---|---|---|
| 1 | 88.0 | 73.8 | 0.84 |
| 2 | 123.0 | 66.4 | 0.54 |
| 3 | 82.7 | 79.3 | 0.96 |
| **median** | **88.0** | **73.8** | **x0.84** |

All six pairs favour v9. Stalls: 40/40 frames >33 ms in every cell — this host batch ran at
70-120 ms per frame, so the stall counter cannot separate anything here; the paired interval
is the signal. Earlier 3-round scratch run in a faster regime: x0.84 rest / x0.81 hover.

### Verdict

Ship it, with a switch. The resting frame is x0.94 and hover x0.84 (x0.84/x0.81 in the faster
batch), capability is intact, and 3 483 of 3 876 edges stop being individual strokes.

It fails the lane's 2%-of-painted bar, and the failure is understood rather than hidden:
**10.2% of painted pixels differ in colour only, because the batch changes which edge is on top
at a crossing.** Geometry, width, colour palette, dashes, arrowheads, selection and filtering
are exact. If pixel-identical rest is ever preferred over the frame win, `_REST_EDGE_BATCH =
false` in `graphify/exporters/html.py` puts vis back in charge at rest and leaves every other
lever untouched.
