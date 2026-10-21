# L17 — the first open: where do the 9.9 s go, and can they go without the layout?

## Hypothesis

The first open of an exported graph takes ~9.9 s on rsl (1886 nodes / 3876 edges). About
6.3 s of that is vis's on-load solver (200 stabilization iterations) and ~1.7 s is parse +
construct + first paint. If the layout could be reached with fewer iterations, the open
would get much faster. The risk is the obvious one: the 200-iteration layout is what gives
the graph its community structure (D50: at 30 iterations it is "a dense hairball with no
community structure").

Two ways out:

1. fewer iterations (fast, probably ruins the picture),
2. a better *starting point* for the same number of iterations (the solver does the same
   amount of work, so it cannot be faster - but it could reach the same structure in fewer
   iterations, and that is what this lane measures).

## Method

- `harness/ab_load.mjs` - interleaved first-open A/B, fresh browser context per variant
  (cold layout cache), odd rounds, ready/DCL/load reported.
- `harness/probe_layout.mjs` - reads the stabilized positions out of the page and reports
  the metrics that describe "does this look like a graph": edge lengths, the ratio of
  intra- to inter-community edge length, community separation, the exact number of edge
  crossings, and the number of edges shorter than 25 units.
- `harness/mk_l17.py` / `mk_l18.py` / `mk_l19.py` - scratch variants.

## Results

### Fewer iterations are not an option (rsl, 3 interleaved rounds, `results/ab-load-L17.csv`)

| variant | ready (median) | crossings | community separation | intra/inter edge length |
|---|---|---|---|---|
| 200 iterations (shipped) | 10 508 ms | 77 173 | 7.23 | 0.64 |
| 200 iterations, `improvedLayout: false` | 10 412 ms (x0.99) | - | - | - |
| 60 iterations | 2 261 ms (x0.22) | 394 409 | 1.89 | 1.05 |
| 30 iterations | 1 493 ms (x0.14) | 915 080 | 1.23 | 0.99 |

`improvedLayout` is not the cost (x0.99). Fewer iterations are fast and ruin the picture:
at 60 iterations the graph has 5x the edge crossings and the communities no longer hold
together (separation 7.2 -> 1.9, and intra-community edges are no shorter than
inter-community ones - the "cluster" look is gone).

### A community-aware seed does not rescue it (60 iterations, community-aware seed)

Placing the communities apart and their members around their community centre before the
solver starts (`mk_l18.py`) gives, at 200 iterations, a *better* layout than the shipped
spiral seed (crossings 72 729 vs 77 173, separation 8.8 vs 7.23). At 60 iterations it
still collapses into a central blob: crossings 181 671, separation 5.92, and the picture is
a hairball with satellites.

### The one cheap win: `avoidOverlap` is 17% of the open

`avoidOverlap` is an O(n^2) node-pair pass per iteration. `avoidOverlap: 0` opens in
9 140 ms against 11 035 ms (x0.83, `results/ab-load-L19.csv`) with the same 200 iterations.

## Verdict

The open time is the solver, and the solver's *result* is what the user sees. Nothing that
keeps the picture is free:

- the only lever that reaches the same picture faster is **precomputing the layout** (the
  existing `--bake` path: 1 722 ms, x0.16) - which still needs the packaging decision
  (Node + Chrome at export time, or a layout implementation in Python),
- `avoidOverlap: 0` buys 17% of the open and changes the picture (nodes may overlap), so it
  is not adopted without a look at it,
- fewer iterations and better seeds are rejected on the evidence above.

The honest summary: **the first open cannot be made much faster without moving the layout
offline.** Everything else in this lane is a dead end, and that is worth having written
down.
