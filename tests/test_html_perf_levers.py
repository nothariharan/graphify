"""Perf levers in the HTML exporter (#perf).

Dense graphs defer arrowheads to hover, take over the edge pass and lean the node
draw during a drag/zoom gesture, and every graph caches its stabilized layout so a
re-open skips the on-load solver. Levers must be invisible below the density
thresholds and must not drop direction/confidence/connectivity. Edges are never
hidden: `hideEdgesOnDrag`/`hideEdgesOnZoom` looked like the graph was falling apart
while moving it, so the gesture work keeps every edge and every node drawn.

Measured (rsl 1886 nodes / 3876 edges, interleaved same-machine A/B, 3 rounds): borders
off the nodes + the batched edge pass took a node drag 40.4 -> 82.9 fps, pan 39.1 -> 78.9
fps and zoom 15.2 -> 80.4 fps, with stalled frames (>33ms) falling from 13-91/90 to 0-1/90.
The paired ratio has come out anywhere between x1.7 and x5.8 across runs because this host
drifts ~3x between rounds (the same shipped file measured 15.0 fps and 43.7 fps in
consecutive rounds of a single run), so the paired ratio is the durable number, never the
absolute fps. Neither lever touches the stored data or the resting draw: the batch is
removed on release and the frame after it is identical to the frame before it (5762
ctx.stroke(), 3876 quadratic curves, same colour set), and the lean writes widths onto the
node instances rather than calling network.setOptions, which would add a ~200ms
synchronous redraw at dragStart/dragEnd.

The batch draws the same curve vis draws at rest, not a straight line: a frame-by-frame
pixel diff against the resting frame changes 1.1-1.8% of painted pixels with the curve
versus 82-100% with straight lines, and the via point it computes agrees with vis's own
getViaNode() for all 3876 edges.
"""
from __future__ import annotations

import re
from pathlib import Path

import networkx as nx

from graphify.exporters.html import (
    ARROW_DEFER_EDGE_THRESHOLD,
    LEAN_GESTURE_NODE_THRESHOLD,
    to_html,
)


def _render(tmp_path: Path, n: int, k: int) -> tuple[str, int]:
    """A graph with ~n*k/2 edges: nodes 0..n-1, each wired to the next k."""
    G = nx.Graph()
    for i in range(n):
        G.add_node(f"n{i}", label=f"node{i}", community=i % 5)
    for i in range(n):
        for j in range(i + 1, min(n, i + k)):
            G.add_edge(f"n{i}", f"n{j}", relation="calls", confidence="EXTRACTED")
    comms: dict[int, list[str]] = {}
    for i in range(n):
        comms.setdefault(i % 5, []).append(f"n{i}")
    out = tmp_path / "graph.html"
    to_html(G, comms, str(out), node_limit=10**9)
    return out.read_text(encoding="utf-8"), G.number_of_edges()


def test_sparse_graph_keeps_eager_arrowheads(tmp_path):
    html, edges = _render(tmp_path, 20, 1)
    assert edges <= ARROW_DEFER_EDGE_THRESHOLD
    assert "arrows: { to: { enabled: true, scaleFactor: 0.5 } }," in html
    assert "const _arrowOn" not in html


def test_dense_graph_defers_arrowheads_to_hover(tmp_path):
    html, edges = _render(tmp_path, 120, 25)
    assert edges > ARROW_DEFER_EDGE_THRESHOLD
    assert "arrows: { to: { enabled: false } }," in html
    assert "const _arrowOn" in html
    for ev in ("hoverEdge", "blurEdge", "hoverNode", "blurNode"):
        assert f"network.on('{ev}'" in html


def test_direction_survives_arrow_deferral(tmp_path):
    """Deferral must not touch stored direction: every edge keeps its from/to."""
    html, edges = _render(tmp_path, 120, 25)
    arcs = re.findall(r'"from": "([^"]+)", "to": "([^"]+)"', html)
    assert len(arcs) == edges
    assert len(set(arcs)) == edges


def test_dashes_and_confidence_survive(tmp_path):
    html, edges = _render(tmp_path, 120, 25)
    assert html.count('"dashes":') == edges


def test_layout_cache_emitted_for_every_graph(tmp_path):
    for n, k in ((20, 1), (120, 25)):
        html, _ = _render(tmp_path, n, k)
        assert "function _savePositions()" in html
        assert "graphify-pos:" in html
        assert "localStorage.setItem(POSK" in html


def test_offline_vis_fallback_present(tmp_path):
    """The CDN script must fall back to a sibling vis-network.min.js so a graph
    still renders offline when that file is dropped next to it (L1: blocking the
    CDN otherwise leaves a blank page - `vis is not defined`)."""
    html, _ = _render(tmp_path, 20, 1)
    assert "unpkg.com/vis-network@9.1.6" in html
    assert "vis-network.min.js" in html
    assert "onerror=" in html


# --- lean gesture draw (#perf) ------------------------------------------------
# Node border strokes are the single biggest cost of a drag/zoom frame on a large
# graph (~1900 ctx.stroke() per frame on rsl). The border is dropped for the
# duration of the gesture and restored on release, so the graph must never be left
# permanently borderless.

def test_dense_graph_leans_the_draw_during_gestures(tmp_path):
    html, _ = _render(tmp_path, 900, 3)
    assert "function _setLean(on, redraw)" in html
    assert "network.on('dragStart', function () { _draggingNow = true; _setLean(true); })" in html
    assert "network.on('dragEnd', function () { _draggingNow = false; _setLean(false, true); })" in html
    # borders come back
    assert "_BORDER_FULL = 1.5" in html


def test_lean_writes_node_instances_not_global_setoptions(tmp_path):
    """network.setOptions re-applies the global borderWidth but also costs a full
    synchronous redraw (~200ms on a 2290-node aggregate, 670ms+ at 9142 nodes), which
    landed as a hitch at dragStart and dragEnd. The shipped path mutates the node
    instances instead and keeps setOptions only as a fallback."""
    html, _ = _render(tmp_path, 900, 3)
    assert "n.options.borderWidth = _BORDER_LEAN;" in html
    # the gesture's own frame picks it up, so leaning forces no redraw ...
    assert "if (redraw) { try { network.redraw(); } catch (e) {} }" in html
    # ... while restoring does, because vis does not redraw on pointer-up.
    assert "_setLean(false, true)" in html
    # fallback survives for a vis build without network.body.nodes
    assert "network.setOptions({ nodes: { borderWidth: on ? _BORDER_LEAN : _BORDER_FULL } })" in html
    # and the public-API call is no longer the only thing that runs
    assert html.count("network.setOptions({ nodes: { borderWidth") == 1


def test_lean_remembers_per_node_border_width(tmp_path):
    """Learning-status nodes carry a 3px ring, so restore must put back each node's own
    width rather than a blanket 1.5 - otherwise a gesture would silently thin the ring."""
    html, _ = _render(tmp_path, 900, 3)
    assert "if (!(id in _border0)) _border0[id] = n.options.borderWidth;" in html
    assert "const w = _border0[id];" in html
    assert "n.options.borderWidth = (w === undefined) ? _BORDER_FULL : w;" in html


def test_lean_restores_borders_after_zooming_stops(tmp_path):
    """vis emits no zoom start/end, so the restore must be timer-based."""
    html, _ = _render(tmp_path, 900, 3)
    assert "network.on('zoom'" in html
    assert "_zoomTimer = setTimeout(" in html
    # a drag in progress must not have its lean cleared by a stale zoom timer
    assert "if (!_draggingNow) _setLean(false, true);" in html


def _without_js_comments(html: str) -> str:
    """Comment lines aside, so an assertion about emitted options is not satisfied or
    broken by prose that merely names them."""
    return "\n".join(ln for ln in html.splitlines() if not ln.lstrip().startswith("//"))


def test_edges_stay_visible_during_gestures(tmp_path):
    """Edges must never vanish while panning or zooming (user-visible regression from
    hideEdgesOnDrag/hideEdgesOnZoom): the graph has to look the same in motion as at
    rest. Smoothness comes from drawing them cheaper, never from not drawing them."""
    for n, k in ((20, 1), (900, 3)):
        html, _ = _render(tmp_path, n, k)
        code = _without_js_comments(html)
        assert "hideEdgesOnDrag" not in code
        assert "hideEdgesOnZoom" not in code


# --- batched edge pass (#perf) ------------------------------------------------
# One ctx.stroke() per edge per frame was ~30ms of an rsl frame and the reason a drag
# with the edges visible stayed at ~21fps. vis resolves what to draw while it draws it,
# so per-edge option writes change nothing on screen; the only lever is to take over
# edgeType.drawLine for the gesture and stroke each (colour, dash, width) group once.

def test_dense_graph_batches_the_edge_pass(tmp_path):
    html, _ = _render(tmp_path, 900, 3)
    assert "const _EDGE_BATCH = (function ()" in html
    # the pass replaces drawLine per edge and strokes once per group
    assert "et.drawLine = function (ctx, values, sel, hov, via)" in html
    assert "if (_drawn) return;" in html
    assert "g.strokeStyle = grp.col;" in html
    assert "g.beginPath();" in html
    assert "_groups.push(grp)" in html


def test_edge_batch_groups_by_colour_dash_and_width(tmp_path):
    """Grouping by anything less than what vis varies per edge would silently repaint
    edges: a single-colour batch measured x1.2 faster but dumped every edge in one
    colour."""
    html, _ = _render(tmp_path, 900, 3)
    assert "const key = col + '|' + (dash ? dash.join(',') : '') + '|' + baseW;" in html
    # resolved exactly the way the draw path resolves them
    assert "col = e.edgeType.getColor(_ctx, t);" in html
    assert "t = e.getFormattingValues();" in html
    assert "const dash = _dashOf(t);" in html
    # dashed (confidence) edges keep their pattern inside the batch
    assert "g.setLineDash(grp.dash);" in html
    assert "return d === true ? [5, 5] : d;" in html


def test_edge_batch_reads_live_endpoints_each_frame(tmp_path):
    """edgeType.fromPoint IS the node object, so the batch must read it per frame. A
    batch built once at dragStart would freeze the endpoints and break exactly the node
    drag it is supposed to help."""
    html, _ = _render(tmp_path, 900, 3)
    assert "g.moveTo(et.fromPoint.x, et.fromPoint.y);" in html
    assert "g.lineTo(et.toPoint.x, et.toPoint.y);" in html
    # no cached coordinate array
    assert not re.search(r"pts\.push\(", html)


def test_edge_batch_width_is_rederived_per_frame(tmp_path):
    """vis draws edges at max(width, 0.3/scale) and the floor moves with the zoom, so the
    width cannot be baked in at gesture start."""
    html, _ = _render(tmp_path, 900, 3)
    assert "const floor = 0.3 / _scale();" in html
    assert "g.lineWidth = Math.max(grp.baseW, floor);" in html


def test_edge_batch_draws_the_resting_curve(tmp_path):
    """Straight lines are cheaper but they are a visibly different graph in motion: the
    frame-by-frame pixel diff against the resting frame changed 82-100% of painted pixels
    with straight lines and 1.1-1.8% with the curve vis actually draws."""
    html, _ = _render(tmp_path, 900, 3)
    assert "function _curveTo(g, et) {" in html
    assert "_curveTo(g, et);" in html
    assert "g.quadraticCurveTo(vx, vy, et.toPoint.x, et.toPoint.y);" in html
    # anything that is not a continuous smooth edge is still a straight line
    assert ("if (!o || o.enabled === false || o.type !== 'continuous') "
            "{ g.lineTo(et.toPoint.x, et.toPoint.y); return; }") in html
    # the via point is vis's own arithmetic: roundness * dominant extent, signed toward
    # `to`, then clamped into the segment's box
    assert "let a = (C <= I) ? e * I : e * C;" in html
    assert "if (C <= I) vx = (fx <= tx) ? (tx < vx ? tx : vx) : (tx > vx ? tx : vx);" in html


def test_edge_batch_is_removed_on_release(tmp_path):
    """The patch must be undone the moment the gesture ends, and the batch reset per
    frame via vis's own afterDrawing event."""
    html, _ = _render(tmp_path, 900, 3)
    assert "delete et.drawLine;" in html
    assert "delete et.__leanBatch;" in html
    assert "network.on('afterDrawing', function () { _EDGE_BATCH.frame(); });" in html
    # a throwing batch falls back to vis's own draw instead of a blank canvas
    assert "if (_errors > 2) { _set(false); }" in html
    assert "orig.call(this, ctx, values, sel, hov, via);" in html
    # gesture lifecycle drives it alongside the border lean
    assert "_EDGE_BATCH.set(on);" in html


def test_lean_is_size_gated_not_edge_gated(tmp_path):
    """A big-but-sparse graph gets the lean draw and no arrow deferral."""
    html, edges = _render(tmp_path, LEAN_GESTURE_NODE_THRESHOLD + 100, 1)
    assert edges <= ARROW_DEFER_EDGE_THRESHOLD
    assert "arrows: { to: { enabled: true, scaleFactor: 0.5 } }," in html
    assert "const _arrowOn" not in html
    assert "function _setLean(on, redraw)" in html


def test_sparse_small_graph_gets_none_of_the_gesture_levers(tmp_path):
    """Byte-level promise: a small graph is untouched by any of this."""
    html, _ = _render(tmp_path, 20, 1)
    for marker in ("function _setLean(on, redraw)", "hideEdgesOnZoom", "const _arrowOn",
                   "const _EDGE_BATCH", "_syncArrows", "dragStart"):
        assert marker not in html
    assert "nodes: { shape: 'dot', borderWidth: 1.5 }," in html


def test_dense_arrow_reveal_is_batched_not_per_edge(tmp_path):
    """The old code called edgesDS.update() once per edge, and every one of those
    made vis recompute _updateVisibleIndices + _updateValueRange over all nodes and
    all edges. One batched update for the whole diff instead."""
    html, _ = _render(tmp_path, 120, 25)
    assert "function _syncArrows()" in html
    assert "edgesDS.update(upd);" in html
    assert not re.search(r"edgesDS\.update\(\{\s*id:", html)
    # suppressed while dragging, resynced once on release
    assert "if (!_dragging) _syncArrows();" in html


