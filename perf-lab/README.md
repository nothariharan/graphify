# graphify perf-lab

Controlled measurement + optimization lab for the exported `graph.html` network view.
Nothing here changes the real exporter. Each variant is the shipped artifact plus one
targeted patch, so a measured delta is attributable to that single lever.

**Starting work here — agent or human — read [`AGENTS.md`](AGENTS.md) first.** It holds the
handoff protocol: the hard rules, the measurement contract (bench lock + interleaved A/B),
the evidence registry (which file a finding has to land in), the lane board, the traps that
have already been paid for, and the checklist for a lever to count as done.

## Why
The graph view lags on real graphs (spinner, frozen drag, slow zoom). This lab quantifies
which renderer options actually cost time, keeps the numbers reproducible, and drives an
optimization loop until no further wins remain. Capability (node/edge/community counts,
direction, confidence, connectivity) must not be reduced.

## Layout
- `AGENTS.md`              handoff protocol: rules, measurement contract, evidence registry, lanes.
- `harness/bench_lock.py`  exclusive gate for every measured run + `results/bench-runs.log` audit trail.
- `harness/ab_drag.mjs`   interleaved A/B/C drag battery (the primary instrument for gestures).
- `harness/probe_*.mjs`   fidelity probes: canvas ops (`probe_borderdraw`), batched-edge draw
                          (`probe_edgebatch`), in-motion vs resting pixels (`probe_motion_pixels`).
- `harness/measure.mjs`  headless-Chrome battery; appends one CSV row per run.
- `harness/variants.py`  builds variants from a base `graph.html`.
- `harness/sweep.ps1`    one graph x variants x dprs x reps.
- `variants/base-*.html` base artifacts (vis-network localized to `/data/`).
- `variants/<graph>__vNN-*.html`  generated variants.
- `data/vis-network.min.js`       local renderer (no unpkg dependency in-lab).
- `results/measurements.csv`      canonical results table.
- `results/chart.html`            self-contained chart (no CDN).
- `results/lanes/<lane>.csv`      per-lane result slices.
- `lanes/<lane>.md`               per-lane brief + status.
- `STATE.md` / `LOG.md` / `DECISIONS.tsv`  loop memory, chronological log, decision trail.

## Run
```powershell
cd perf-lab
powershell -NoProfile -File harness/sweep.ps1 -Graph rsl -Lane L2 -Dprs "1,2" -Csv results/measurements.csv
python harness/chart.py            # -> results/chart.html
```
`-Only v13-hover-arrows,v02-noarrows` limits both generation and measurement.
Warm-up is on by default: the first two launches are ~18% cold, so a throwaway
`base-httpx` run happens first. Do not remove it.

## Instrument (what each number means)
- `load_ms` / `dcl_ms`: navigation timing (script parse+exec, incl. on-load physics).
- `redraw_min/med/p95`: time of a single forced canvas redraw (`network.redraw()` +
  rAF settle), 15 samples, first dropped. **min is the stable signal**; med/p95 carry
  scheduler jitter.
- `pan_fps` / `zoom_fps` / `hover_fps`: rAF frame rate during scripted interaction.
  These depend on viewport contents, which depends on layout, so compare like-to-like.
- `longtask_*`: PerformanceObserver long tasks (>50ms) attributable to rendering.
- `heap_mb`: CDP renderer heap after the battery (page-level, not absolute).
- `canvas_px`: drawing-buffer pixels = css_w x css_h x dpr^2. Used to separate
  fill-rate cost from CPU geometry cost.

## Caveats
- Headful Chrome throttles rAF when occluded, so headless is the instrument. Headless
  numbers are relative-truth, not an exact match for the user's window size/DPR.
- `pan/zoom/hover_fps` are confounded by layout (nosim leaves a spiral spread, so a
  different set of nodes/edges is on screen). Compare interaction fps only within the
  same layout, or treat `redraw_*` as the primary metric.
- One run is not enough for a claim: re-run a lane and aggregate `redraw_min` across
  reps before shipping a lever.

## Data ladder
httpx 144/330 · karpathy ~177 · mixed-corpus ~22 · rsl 1886/3876 · repo 18147 ·
continuum 9142/27099 · gsoc 104260/292661.
