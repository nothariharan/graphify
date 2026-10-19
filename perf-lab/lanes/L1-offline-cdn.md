# Lane L1 — offline / CDN robustness

Owner: subagent (deepseek-v4.1-flash-free). Primary metric: does the view render with
no network (pageErrors empty, canvasCount>0, nodes/edges drawn)?

## Brief
Shipped `graph.html` loads vis-network from `https://unpkg.com/...` with no fallback
(html.py L733). If unpkg is slow/down/blocked, the whole UI script aborts.
Capability at stake: the graph must open offline and on a cold/blocked network.

## Steps
1. Confirm failure: variants already localize to `/data/vis-network.min.js`; block it and
   show `vis is not defined`. Record in LOG.
2. Decide delivery: inline the 686KB bundle into the HTML, or ship a sibling file + <script>
   fallback. Measure HTML size delta and load_ms delta for each on httpx/rsl.
3. Verify: offline (no network) load renders; pageErrors == [].

## Status
Failure CONFIRMED then FIXED (2026-10-16). Blocking the CDN leaves `canvasCount:0` and
`pageErrors: vis is not defined / network is not defined` (whole UI script aborts).
Shipped fix: the CDN `<script>` now carries `onerror` that appends a sibling
`vis-network.min.js`, so dropping that file next to `graph.html` renders offline.
Chose the fallback over inlining the 686 KB bundle (keeps every graph.html small and
keeps the CDN default, so no added latency when online). Covered by
`tests/test_html_perf_levers.py::test_offline_vis_fallback_present`.
Not verified end-to-end offline (needs a real sibling bundle file next to a real export).
