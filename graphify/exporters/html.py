"""html — moved verbatim from graphify/export.py."""
from __future__ import annotations

from graphify.exporters.base import COMMUNITY_COLORS  # noqa: E402,F401
from pathlib import Path
import html as _html
from graphify.analyze import _node_community_map
from graphify.paths import write_text_atomic
import json
import networkx as nx
from graphify.security import sanitize_label


MAX_NODES_FOR_VIZ = 5_000
_HTML_STALE_MARKER = ".graph.html.stale"

# Dense graphs spend most of every canvas redraw on per-edge arrowheads. Above
# this many edges the exporter stops drawing an arrowhead on every edge every
# frame and reveals them on hover instead (edge hover, or node hover for all
# incident edges). Direction is never lost - it moves from "always drawn" to
# "drawn on hover" only for graphs where drawing them is what makes pan/zoom lag
# (measured: rsl/continuum/gsoc-aggregate redraw -63%..-67%). Below the
# threshold the render is byte-identical to before. (#perf)
ARROW_DEFER_EDGE_THRESHOLD = 1_500

# Above this many nodes, a drag/pan gesture drops node border strokes (cosmetic) for
# the length of the gesture and restores them on release. Measured on rsl (1886 nodes,
# same machine, interleaved A/B): node drag 15.7 -> 60.9 fps, pan 15.0 -> 64.8 fps,
# frames over 33ms 119/120 -> 5/120. ~1900 per-frame ctx.stroke() calls for 1.5px
# borders were choking the canvas raster pipeline - it is the single biggest cost in a
# drag frame, bigger than the edges. Below the threshold the render is byte-identical.
LEAN_GESTURE_NODE_THRESHOLD = 800

# Emitted only when arrowheads are deferred. Single braces: this string is
# interpolated verbatim into the script (not itself an f-string).
_ARROW_HOVER_JS = """
// Deferred arrowheads (#perf). Direction is shown, not lost: hover an edge, or a
// node (all its incident edges), to see the arrowheads.
//
// Two rules keep this off the hot path (measured with harness/profile_drag.mjs):
//   1. BATCH. Every edgesDS.update() makes vis run _updateVisibleIndices() plus
//      _updateValueRange() over ALL nodes and ALL edges and request a redraw. The
//      earlier per-edge update loop did that once per arrow flipped, so hovering a
//      hub node fired dozens of full body recomputes; a node drag fell to 17.8fps
//      vs 44fps with hover off. One batched update per hover change instead.
//   2. NO CHURN DURING A DRAG. Hover events fired mid-pull are noise; they made the
//      graph feel like it was fighting the pointer. Defer, then resync once on dragEnd.
const _arrowOn = new Set();
let _hoverNode = null, _hoverEdge = null, _dragging = false;
function _syncArrows() {
  const want = new Set();
  if (_hoverEdge !== null) want.add(_hoverEdge);
  if (_hoverNode !== null) {
    const inc = network.getConnectedEdges(_hoverNode);
    for (const id of inc) want.add(id);
  }
  const upd = [];
  for (const id of _arrowOn) {
    if (!want.has(id)) { _arrowOn.delete(id); upd.push({ id: id, arrows: { to: { enabled: false } } }); }
  }
  for (const id of want) {
    if (!_arrowOn.has(id)) { _arrowOn.add(id); upd.push({ id: id, arrows: { to: { enabled: true, scaleFactor: 0.5 } } }); }
  }
  if (!upd.length) return;
  try { edgesDS.update(upd); } catch (e) {}
}
network.on('hoverNode', function (p) { _hoverNode = p.node; if (!_dragging) _syncArrows(); });
network.on('blurNode', function () { _hoverNode = null; if (!_dragging) _syncArrows(); });
network.on('hoverEdge', function (p) { _hoverEdge = p.edge; if (!_dragging) _syncArrows(); });
network.on('blurEdge', function () { _hoverEdge = null; if (!_dragging) _syncArrows(); });
network.on('dragStart', function () { _dragging = true; });
network.on('dragEnd', function () { _dragging = false; _syncArrows(); });
"""

# Always emitted. Caches this graph's stabilized layout so a re-opened graph
# skips the on-load solver (measured load -73%). The cached x/y ARE this graph's
# own stabilized positions, so layout and every capability are identical; only
# the recompute cost is removed. Best-effort: localStorage may throw (file://,
# private mode) - then behavior is exactly as before.
_POSITION_CACHE_JS = """
// Stabilized-layout cache (#perf).
const POSK = 'graphify-pos:' + RAW_NODES.length + ':'
  + String(RAW_NODES.length ? RAW_NODES[0].id : '') + ':'
  + String(RAW_NODES.length ? RAW_NODES[RAW_NODES.length - 1].id : '');
function _savePositions() {
  try {
    const p = network.getPositions();
    const out = {};
    for (const id in p) { out[id] = [Math.round(p[id].x * 100) / 100, Math.round(p[id].y * 100) / 100]; }
    localStorage.setItem(POSK, JSON.stringify(out));
  } catch (e) {}
}
(function _restorePositions() {
  let raw = null;
  try { raw = localStorage.getItem(POSK); } catch (e) { return; }
  if (!raw) return;
  let pos = null;
  try { pos = JSON.parse(raw); } catch (e) { return; }
  if (!pos || typeof pos !== 'object') return;
  const upd = [];
  for (const n of RAW_NODES) { const p = pos[n.id]; if (p) upd.push({ id: n.id, x: p[0], y: p[1] }); }
  if (upd.length < RAW_NODES.length) return;  // stale/partial -> re-solve
  try {
    network.setOptions({ physics: { enabled: false } });
    nodesDS.update(upd);
    network.fit({ animation: false });
  } catch (e) {}
})();
"""

# Emitted only for large graphs (see LEAN_GESTURE_NODE_THRESHOLD). Plain string, single
# braces, interpolated verbatim.
_LEAN_GESTURE_JS = """
// Lean draw during gestures (#perf): borders off the nodes, one stroke for the edges.
//
// Nodes: the border costs one ctx.stroke() per node per frame (~1900 strokes on rsl) and
// the raster pipeline cannot keep up, so a drag settled at ~15fps. Dropping borders for
// the duration of the gesture takes that past 40fps and cuts stalled frames (over 33ms)
// from 89/90 to a handful. The border is cosmetic and returns the instant the pointer is
// released.
//
// Every element is still drawn. Edges used to simply vanish while the view moved, first
// because the shipped build set hideEdgesOnDrag/hideEdgesOnZoom, and then because hiding
// them was the only way to stay smooth: vis issues one ctx.stroke() per edge per frame
// (3876 on rsl, ~30ms) and no option change removes that - the draw path fills its values
// in from the instance options during the draw, so writing edge.options.smooth/width
// mid-gesture changes the data and nothing on screen. What does work is taking over the
// edge pass for the length of the gesture and stroking each (colour, dashes, width) group
// once. On rsl 3876 strokes collapse to ~20 for the same pixels, and the endpoints are
// read live each frame (edgeType.fromPoint IS the node object), so edges still follow a
// node being dragged.
//
// Both levers are written straight onto the instances rather than through
// network.setOptions(): setOptions re-applies the global options but also costs a full
// synchronous redraw (measured: ~80ms on rsl, ~200ms on a 2290-node aggregate, 670-2000ms
// on a 9142-node graph), which landed as one hitch at dragStart and another at dragEnd.
// Mutating the instances costs nothing and the drag's own next frame picks it up. The
// original border width of every node is remembered because learning-status nodes carry a
// 3px ring and must get it back, not 1.5px.
const _BORDER_FULL = 1.5, _BORDER_LEAN = 0;
let _lean = false, _draggingNow = false, _zoomTimer = null, _border0 = null;

// Batched edge pass. vis draws each edge by calling edgeType.drawLine(ctx, values, ...);
// for the duration of a gesture that call is replaced by one draw of every edge, grouped
// by the colour/dash/width it would have been drawn with, so the reused ctx state is
// identical. The replacement is deleted on release, which restores the prototype method.
const _EDGE_BATCH = (function () {
  let _installed = false, _drawn = false, _groups = null, _ctx = null, _errors = 0;
  let _rest = false, _dirty = false;

  function _dashOf(t) {
    const d = t.dashes;
    if (d === false || d === null || d === undefined) return null;
    return d === true ? [5, 5] : d;
  }

  // An edge that is showing its arrowhead cannot be drawn by the batch: the batch draws
  // the line, not the arrow. Dense graphs defer arrows to hover, so this is the edges the
  // user is currently inspecting.
  function _arrowed(et) {
    const a = et && et.options && et.options.arrows;
    return !!(a && a.to && a.to.enabled === true);
  }

  function _scale() {
    try { return network.body.view.scale || network.getScale(); } catch (e) { return 1; }
  }

  function _build() {
    const body = network.body;
    const es = body && body.edges;
    if (!es) return false;
    if (!_ctx) {
      _ctx = (body.renderer && body.renderer.ctx) || (function () {
        try { return document.createElement('canvas').getContext('2d'); } catch (e) { return null; }
      })();
    }
    const map = new Map();
    for (const id in es) {
      const e = es[id];
      if (!e || !e.connected || !e.edgeType) continue;
      // vis draws an edge only when the edge and BOTH endpoints are visible
      // (Body._updateVisibleIndices). Legend filtering hides nodes, not edges, so without
      // this the cached batch would keep drawing the hidden node's edges.
      const fo = e.from && e.from.options, to = e.to && e.to.options;
      if ((e.options && e.options.hidden) || (fo && fo.hidden) || (to && to.hidden)) continue;
      let t = null;
      try { t = e.getFormattingValues(); } catch (err) { continue; }
      if (!t || t.hidden) continue;
      let col = null;
      try { col = e.edgeType.getColor(_ctx, t); } catch (err) { continue; }
      if (typeof col !== 'string') continue;  // gradient / exotic: leave it to vis
      // Dashed edges (INFERRED confidence) keep vis's own draw. Their dash rendering has to
      // match vis exactly and there are few of them on a dense graph (393 of 3876 on rsl),
      // so 393 strokes beat risking a differently-dashed confidence encoding.
      if (_dashOf(t)) { e.edgeType.__leanDash = true; continue; }
      if (e.edgeType.__leanDash) delete e.edgeType.__leanDash;
      const baseW = (e.options && typeof e.options.width === 'number') ? e.options.width : t.width;
      const key = col + '|' + baseW;
      let grp = map.get(key);
      if (!grp) map.set(key, grp = { col: col, baseW: baseW, ets: [] });
      grp.ets.push(e.edgeType);
    }
    _groups = [];
    for (const grp of map.values()) _groups.push(grp);
    return _groups.length > 0;
  }

  // The exact curve vis draws at rest for `smooth: {type: 'continuous'}`: a quadratic
  // through the same via point BezierEdgeDynamic._getViaCoordinates computes (offset from
  // `from` by roundness * the dominant extent, signed toward `to`, clamped into the
  // segment's box). Drawing straight lines in the batch instead is faster still, but it is
  // visibly a different graph in motion: a frame-by-frame pixel diff against the resting
  // frame shows 82-100% of painted pixels changing with straight lines versus 1.1-1.8%
  // with the curve. Anything that is not a continuous smooth edge falls back to a line.
  function _curveTo(g, et) {
    const o = et.options && et.options.smooth;
    if (!o || o.enabled === false || o.type !== 'continuous') { g.lineTo(et.toPoint.x, et.toPoint.y); return; }
    const fx = et.from.x, fy = et.from.y, tx = et.to.x, ty = et.to.y;
    const e = o.roundness, C = Math.abs(fx - tx), I = Math.abs(fy - ty);
    let a = (C <= I) ? e * I : e * C;
    let b = a;
    if (fx > tx) a = -a;
    if (fy >= ty) b = -b;
    let vx = fx + a, vy = fy + b;
    if (C <= I) vx = (fx <= tx) ? (tx < vx ? tx : vx) : (tx > vx ? tx : vx);
    else vy = (fy >= ty) ? (ty > vy ? ty : vy) : (ty < vy ? ty : vy);
    g.quadraticCurveTo(vx, vy, et.toPoint.x, et.toPoint.y);
  }

  function _drawAll(g) {
    const groups = _groups;
    if (!groups || !g) return;
    const floor = 0.3 / _scale();
    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      const ets = grp.ets;
      g.strokeStyle = grp.col;
      // vis sets lineWidth to max(width, 0.3/scale) on every draw; the floor moves with
      // the zoom, so it has to be re-derived per frame rather than baked in at dragStart.
      g.lineWidth = Math.max(grp.baseW, floor);
      g.beginPath();
      for (let j = 0; j < ets.length; j++) {
        const et = ets[j];
        g.moveTo(et.fromPoint.x, et.fromPoint.y);
        _curveTo(g, et);
      }
      g.stroke();
    }
  }

  // Patch every edge instance's drawLine. Idempotent per edge instance: vis replaces the
  // edgeType when an edge's options change (a hovered edge gets its arrowhead back), so the
  // patch has to be re-applied to the new instances after a data change.
  function _patch() {
    const es = network.body && network.body.edges;
    if (!es) return;
    for (const id in es) {
      const et = es[id] && es[id].edgeType;
      if (!et || et.__leanBatch) continue;
      const orig = et.drawLine;
      et.__leanBatch = orig;
      et.drawLine = function (ctx, values, sel, hov, via) {
        // Selected and hovered edges keep vis's own draw: the batch knows the colour and
        // the width, but not the selection highlight or the arrowhead.
        if (sel || hov || this.__leanDash || _arrowed(this)) { orig.call(this, ctx, values, sel, hov, via); return; }
        if (_drawn) return;          // the other 3875 edges are already on the canvas
        _drawn = true;
        try { _drawAll(ctx); return; } catch (err) {
          _errors++;
          if (_errors > 2) { _uninstall(); }
        }
        orig.call(this, ctx, values, sel, hov, via);
      };
    }
  }

  function _install() {
    if (_installed || !_build()) return;
    _patch();
    _installed = true;
  }

  function _uninstall() {
    if (!_installed) return;
    try {
      const es = network.body && network.body.edges;
      for (const id in es) {
        const et = es[id] && es[id].edgeType;
        if (!et || !et.__leanBatch) continue;
        delete et.drawLine;          // back to the prototype implementation
        delete et.__leanBatch;
      }
    } catch (e) {}
    _installed = false;
    _groups = null;
    _drawn = false;
  }

  function _set(on) {
    // With the batch installed at rest (L12) the gesture flag has nothing left to change:
    // it is already drawing every edge, and uninstalling on release would undo the win.
    if (_rest) return;
    if (on) _install(); else _uninstall();
  }

  return {
    set: _set,
    setRest: function (on) {
      _rest = !!on;
      if (_rest) _install(); else _uninstall();
    },
    dirty: function () { _dirty = true; },
    frame: function () {
      _drawn = false;
      if (_dirty && _installed) { _dirty = false; _build(); _patch(); }
    },
  };
})();

function _setLean(on, redraw) {
  if (on === _lean) return;
  _lean = on;
  _EDGE_BATCH.set(on);
  let applied = false;
  try {
    const nodes = network.body && network.body.nodes;
    if (nodes) {
      if (!_border0) _border0 = {};
      for (const id in nodes) {
        const n = nodes[id];
        if (!n || !n.options) continue;
        if (on) {
          if (!(id in _border0)) _border0[id] = n.options.borderWidth;
          n.options.borderWidth = _BORDER_LEAN;
        } else {
          const w = _border0[id];
          n.options.borderWidth = (w === undefined) ? _BORDER_FULL : w;
        }
        applied = true;
      }
    }
  } catch (e) { applied = false; }
  if (!applied) {
    // Fallback for a vis build without network.body.nodes: global option, plus a
    // redraw on restore the way that path always needed.
    try { network.setOptions({ nodes: { borderWidth: on ? _BORDER_LEAN : _BORDER_FULL } }); } catch (e) {}
    return;
  }
  // A drag/zoom redraws itself, so leaning needs no redraw; restoring does, because vis
  // does not redraw when the pointer is released (measured: zero canvas strokes in the
  // 20 frames after pointerup unless something forces one).
  if (redraw) { try { network.redraw(); } catch (e) {} }
}
// One batched edge pass per frame: afterDrawing fires once per vis draw.
network.on('afterDrawing', function () { _EDGE_BATCH.frame(); });
// L12 (#perf): the batched pass is cheaper than one stroke per edge, so on dense graphs
// (arrowheads already deferred) it stays installed at rest instead of only during a
// gesture. Any data change - legend toggle, arrow reveal, theme - can change a group key
// or replace edge instances, so mark the cache dirty and let the next frame rebuild it.
_EDGE_BATCH.setRest(_REST_EDGE_BATCH);
try {
  nodesDS.on('*', function () { _EDGE_BATCH.dirty(); });
  edgesDS.on('*', function () { _EDGE_BATCH.dirty(); });
} catch (e) {}
network.on('dragStart', function () { _draggingNow = true; _setLean(true); });
network.on('dragEnd', function () { _draggingNow = false; _setLean(false, true); });
// vis emits no zoom start/end, so lean for the duration of the zoom and restore once
// the gesture goes quiet (180ms). This took rsl's zoom from 14.2 to ~50fps.
network.on('zoom', function () {
  _setLean(true);
  clearTimeout(_zoomTimer);
  _zoomTimer = setTimeout(function () { if (!_draggingNow) _setLean(false, true); }, 180);
});
"""


def _viz_node_limit() -> int:
    """Return the effective viz node limit, honoring GRAPHIFY_VIZ_NODE_LIMIT env var.

    Falls back to MAX_NODES_FOR_VIZ when the env var is unset, empty, or non-integer.
    Set to 0 to disable HTML viz unconditionally (useful for CI runners).
    """
    import os
    raw = os.environ.get("GRAPHIFY_VIZ_NODE_LIMIT")
    if raw is None or not raw.strip():
        return MAX_NODES_FOR_VIZ
    try:
        return int(raw)
    except ValueError:
        return MAX_NODES_FOR_VIZ

def _html_styles() -> str:
    return """<style>
  :root {
    --bg: #0f0f1a; --panel: #1a1a2e; --border: #2a2a4e; --input-border: #3a3a5e;
    --text: #e0e0e0; --text-2: #aaa; --text-3: #ccc; --muted: #555; --count: #666;
    --neighbor-border: #333; --node-label: #ffffff;
  }
  [data-theme="light"] {
    --bg: #ffffff; --panel: #f8f9fa; --border: #d9dee5; --input-border: #c3cad4;
    --text: #222222; --text-2: #666666; --text-3: #333333; --muted: #888888; --count: #777777;
    --neighbor-border: #ccc; --node-label: #222222;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; height: 100vh; overflow: hidden; }
  #graph { flex: 1; }
  #sidebar { width: 280px; background: var(--panel); border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
  #search-wrap { padding: 12px; border-bottom: 1px solid var(--border); }
  #search { width: 100%; background: var(--bg); border: 1px solid var(--input-border); color: var(--text); padding: 7px 10px; border-radius: 6px; font-size: 13px; outline: none; }
  #search:focus { border-color: #4E79A7; }
  #search-results { max-height: 140px; overflow-y: auto; padding: 4px 12px; border-bottom: 1px solid var(--border); display: none; }
  .search-item { padding: 4px 6px; cursor: pointer; border-radius: 4px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .search-item:hover { background: var(--border); }
  #info-panel { padding: 14px; border-bottom: 1px solid var(--border); min-height: 140px; }
  #info-panel h3 { font-size: 13px; color: var(--text-2); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  #info-content { font-size: 13px; color: var(--text-3); line-height: 1.6; }
  #info-content .field { margin-bottom: 5px; }
  #info-content .field b { color: var(--text); }
  #info-content .empty { color: var(--muted); font-style: italic; }
  .neighbor-link { display: block; padding: 2px 6px; margin: 2px 0; border-radius: 3px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 3px solid var(--neighbor-border); }
  .neighbor-link:hover { background: var(--border); }
  #neighbors-list { max-height: 160px; overflow-y: auto; margin-top: 4px; }
  #legend-wrap { flex: 1; overflow-y: auto; padding: 12px; }
  #legend-wrap h3 { font-size: 13px; color: var(--text-2); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  .legend-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; border-radius: 4px; font-size: 12px; }
  .legend-item:hover { background: var(--border); padding-left: 4px; }
  .legend-item.dimmed { opacity: 0.35; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .legend-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-count { color: var(--count); font-size: 11px; }
  #stats { padding: 10px 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  #legend-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 4px 0; }
  #legend-controls label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: var(--text-2); user-select: none; }
  #legend-controls label:hover { color: var(--text); }
  .legend-cb, #select-all-cb { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border: 1.5px solid var(--input-border); border-radius: 3px; background: var(--bg); cursor: pointer; position: relative; flex-shrink: 0; }
  .legend-cb:checked, #select-all-cb:checked { background: #4E79A7; border-color: #4E79A7; }
  .legend-cb:checked::after, #select-all-cb:checked::after { content: ''; position: absolute; left: 3.5px; top: 1px; width: 4px; height: 7px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
  #select-all-cb:indeterminate { background: #4E79A7; border-color: #4E79A7; }
  #select-all-cb:indeterminate::after { content: ''; position: absolute; left: 2px; top: 5px; width: 8px; height: 2px; background: #fff; border: none; transform: none; }
  #theme-wrap { display: flex; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  #theme-wrap button { flex: 1; background: var(--bg); color: var(--text-2); border: 1px solid var(--input-border); border-radius: 4px; padding: 3px 0; font-size: 11px; cursor: pointer; }
  #theme-wrap button:hover { color: var(--text); }
  #theme-wrap button[aria-pressed="true"] { background: #4E79A7; border-color: #4E79A7; color: #fff; }
</style>"""

def _hyperedge_script(hyperedges_json: str) -> str:
    return f"""<script>
// Render hyperedges as shaded regions
const hyperedges = {hyperedges_json};
// afterDrawing passes ctx already transformed to network coordinate space.
// Draw node positions raw — no manual pan/zoom/DPR math needed.

// Andrew's monotone chain. Returns the hull in counter-clockwise order, which
// is what the perimeter must be traced in. Collinear and duplicate points
// collapse to the extremes, so degenerate member sets render as a segment
// rather than a zero-area crossed path.
function convexHull(pts) {{
    const p = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const build = seq => {{
        const out = [];
        for (const q of seq) {{
            while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
            out.push(q);
        }}
        out.pop();
        return out;
    }};
    const hull = build(p).concat(build(p.slice().reverse()));
    return hull.length >= 3 ? hull : p;
}}
network.on('afterDrawing', function(ctx) {{
    hyperedges.forEach(h => {{
        const positions = h.nodes
            .map(nid => network.getPositions([nid])[nid])
            .filter(p => p !== undefined);
        if (positions.length < 2) return;
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = '#6366f1';
        ctx.strokeStyle = '#6366f1';
        ctx.lineWidth = 2;
        ctx.beginPath();
        // Centroid and expanded hull in network coordinates.
        // The perimeter must follow hull order, not h.nodes order: tracing the
        // raw member order self-intersects whenever the layout does not happen
        // to place members in angular order, filling as crossed wedges.
        const cx = positions.reduce((s, p) => s + p.x, 0) / positions.length;
        const cy = positions.reduce((s, p) => s + p.y, 0) / positions.length;
        const hull = convexHull(positions);
        const expanded = hull.map(p => ({{
            x: cx + (p.x - cx) * 1.15,
            y: cy + (p.y - cy) * 1.15
        }}));
        ctx.moveTo(expanded[0].x, expanded[0].y);
        expanded.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 0.4;
        ctx.stroke();
        // Label
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = '#4f46e5';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(h.label, cx, cy - 5);
        ctx.restore();
    }});
}});
</script>"""

# Interaction feel (#perf L13). Three independent behaviours, all canvas-2d and all
# cheap enough to ship on every export:
#
# 1. Eased wheel zoom. vis zooms once per wheel *event*, and a trackpad fires dozens
#    per frame, so the camera jumps and every event triggers a full redraw. Measured
#    on rsl: 24 long tasks / 2369 ms during a wheel battery, and the user-reported
#    "zoom freezes the graph". Here the target scale is accumulated and approached
#    over rAF frames (one redraw per frame) and the point under the cursor is held
#    fixed. Same battery after: 3 long tasks / 169 ms, zoom_fps 18.4 -> 46.
# 2. Hover focus, Obsidian style: the hovered node and its 1-hop neighbours keep
#    their community colour, everything else is blended toward the background.
#    Restored on blur, never on click (the L11 prototype dimmed on click and left
#    it there, which is what made the graph look washed out). Painting mutates the
#    node instances' options.color and issues one redraw; datasets.update() for
#    1886 nodes measured 149.6 ms and is exactly the hitch this avoids.
# 3. An fps / frame-time HUD on H, for judging a machine's real frame budget.
#    textContent only -- the L11 prototype appended a DOM node every frame.
_UX_JS = """
// ---- interaction feel (#perf L13): eased zoom, hover focus, frame HUD ----
(function () {
  var cont = document.getElementById('graph');
  if (!cont || typeof network === 'undefined') return;

  function gestureActive() {
    try {
      return (typeof _lean !== 'undefined' && _lean) ||
             (typeof _dragging !== 'undefined' && _dragging);
    } catch (e) { return false; }
  }
  function lean(on, redraw) {
    try { if (typeof _setLean === 'function') _setLean(on, redraw); } catch (e) {}
  }

  // ---- 1. eased zoom at the cursor -------------------------------------
  // network.moveTo(..., {animation:false}) does NOT emit zoom/pan in vis 9.1.6
  // (measured: 2 moveTo calls -> 0 zoom, 0 pan), so the lean is driven here
  // explicitly rather than by the 'zoom' handler.
  var fitScale = null, MIN_S = 0.004, MAX_S = 2.0;
  var targetScale = null, curScale = null, anchor = null, raf = 0, animating = false;

  function viewCenter() {
    var r = cont.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function zoomStep() {
    raf = 0;
    if (targetScale === null || !anchor) { animating = false; lean(false, true); return; }
    var c = viewCenter();
    var k = Math.log(targetScale / curScale);
    var next = Math.abs(k) < 0.0025 ? targetScale : Math.exp(Math.log(curScale) + k * 0.25);
    // world point currently under the cursor; hold it there while the scale changes
    var wp = network.DOMtoCanvas({ x: anchor.x, y: anchor.y });
    curScale = next;
    network.moveTo({
      position: { x: wp.x - (anchor.x - c.x) / next, y: wp.y - (anchor.y - c.y) / next },
      scale: next,
      animation: false
    });
    if (next !== targetScale) raf = requestAnimationFrame(zoomStep);
    else {
      animating = false;
      setTimeout(function () { if (!raf) lean(false, true); }, 90);
    }
  }
  cont.addEventListener('wheel', function (e) {
    e.preventDefault();
    e.stopPropagation();          // vis's own per-event wheel handler never sees it
    // Derived on the first wheel, after the fit: a baked build fits after this
    // block runs, and reading it at script time would clamp to the pre-fit scale.
    if (fitScale === null) {
      fitScale = network.getScale();
      MIN_S = Math.max(0.004, fitScale / 6);
      MAX_S = Math.max(0.4, Math.min(2.0, fitScale * 12));
    }
    if (curScale === null) { curScale = network.getScale(); targetScale = curScale; }
    var unit = e.deltaMode === 1 ? 0.05 : (e.deltaMode === 2 ? 1.0 : 0.0016);
    targetScale = Math.max(MIN_S, Math.min(MAX_S, targetScale * Math.exp(-e.deltaY * unit)));
    anchor = { x: e.clientX, y: e.clientY };
    animating = true;
    lean(true);
    if (!raf) raf = requestAnimationFrame(zoomStep);
  }, { passive: false, capture: true });

  // Keep our copy in sync when something else moves the camera (fit, search focus).
  network.on('zoom', function () {
    if (!animating) { curScale = network.getScale(); targetScale = curScale; }
  });

  // ---- 2. hover focus (colour blend, no DataSet update) ----------------
  var BG = '#0f0f1a';
  try {
    var bgv = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bgv) BG = bgv;
  } catch (e) {}
  function rgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(hex, t) {
    var a = rgb(hex), b = rgb(BG);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
                    Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
                    Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }
  var nodesObj = network.body.nodes;
  var orig = new Map(), dimCache = new Map();
  for (var oid in nodesObj) {
    var oc = nodesObj[oid] && nodesObj[oid].options && nodesObj[oid].options.color;
    if (oc && typeof oc === 'object' && oc.background) {
      orig.set(oid, { bg: oc.background, bd: oc.border || oc.background });
    }
  }
  function dimOf(hex) {
    var d = dimCache.get(hex);
    if (!d) { d = mix(hex, 0.55); dimCache.set(hex, d); }
    return d;
  }
  var hoverTimer = 0, hoverOn = false;
  function paint(keep) {
    for (var nid in nodesObj) {
      var n = nodesObj[nid];
      var nc = n && n.options && n.options.color;
      var o = orig.get(nid);
      if (!nc || typeof nc !== 'object' || !o) continue;
      if (!keep || keep.has(nid)) { nc.background = o.bg; nc.border = o.bd; }
      else { var d = dimOf(o.bg); nc.background = d; nc.border = d; }
    }
  }
  function setHover(id) {
    if (gestureActive()) return;      // never fight a drag or a zoom
    var keep = new Set([id]);
    var one = network.getConnectedNodes(id) || [];
    for (var i = 0; i < one.length; i++) keep.add(one[i]);
    paint(keep);
    hoverOn = true;
    network.redraw();
  }
  function clearHover() {
    if (!hoverOn) return;
    paint(null);
    hoverOn = false;
    network.redraw();
  }
  network.on('hoverNode', function (p) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () { setHover(p.node); }, 70);
  });
  network.on('blurNode', function () {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(clearHover, 140);
  });
  network.on('dragStart', function () { clearTimeout(hoverTimer); clearHover(); });

  // ---- 3. frame HUD on H ----------------------------------------------
  var hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;background:rgba(0,0,0,.72);' +
    'color:#fff;font:11px/1.4 ui-monospace,monospace;padding:4px 8px;border-radius:4px;' +
    'display:none;pointer-events:none';
  document.body.appendChild(hud);
  var hudOn = false, frames = 0, t0 = performance.now(), fps = 0;
  var lastT = t0, ft = 0;
  (function loop(t) {
    ft = t - lastT; lastT = t; frames++;
    if (t - t0 >= 500) { fps = Math.round(frames * 1000 / (t - t0)); frames = 0; t0 = t; }
    if (hudOn) hud.textContent = fps + ' fps   ' + ft.toFixed(1) + ' ms';
    requestAnimationFrame(loop);
  })(t0);
  document.addEventListener('keydown', function (e) {
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if ((e.key === 'h' || e.key === 'H') && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      hudOn = !hudOn;
      hud.style.display = hudOn ? 'block' : 'none';
    }
  });
})();
"""


def _html_script(nodes_json: str, edges_json: str, legend_json: str,
                 defer_arrows: bool = False,
                 lean_gestures: bool = False,
                 baked: bool = False) -> str:
    # Arrowheads are deferred to hover only on dense graphs (see
    # ARROW_DEFER_EDGE_THRESHOLD); otherwise emitted exactly as before.
    _arrow_default = "false" if defer_arrows else "true, scaleFactor: 0.5"
    # Pre-baked positions (#perf L10): when the graph ships stabilized x/y,
    # skip the on-load solver entirely (physics off, no stabilization pass).
    physics_enabled = "false" if baked else "true"
    stab_iters = "0" if baked else "200"
    stabilization_handler = "" if baked else (
        "network.once('stabilizationIterationsDone', () => {"
        " network.setOptions({ physics: { enabled: false } });"
        " _savePositions(); });"
    )
    baked_fit_js = "try { network.fit({ animation: false }); } catch (e) {}" if baked else ""
    # L12 (#perf): keep the batched edge pass installed at rest. It is only worth it, and
    # only safe by default, when the arrowheads are already deferred to hover: an edge that
    # draws its arrowhead cannot come out of the batch (see _arrowed in _LEAN_GESTURE_JS).
    lean_js = ""
    if lean_gestures:
        rest_batch = "true" if defer_arrows else "false"
        lean_js = "const _REST_EDGE_BATCH = " + rest_batch + ";\n" + _LEAN_GESTURE_JS
    return f"""<script>
const RAW_NODES = {nodes_json};
const RAW_EDGES = {edges_json};
const LEGEND = {legend_json};

// HTML-escape helper — prevents XSS when injecting graph data into innerHTML
function esc(s) {{
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}}

// Build vis datasets
const nodesDS = new vis.DataSet(RAW_NODES.map((n, i) => ({{
  id: n.id, label: n.label, color: n.color, size: n.size,
  font: n.font, title: n.title,
  // Pre-baked positions (#perf L10): when the graph was baked (x/y shipped),
  // use them verbatim and skip the solver. Otherwise fall back to the
  // Fermat/golden-angle spiral seed (#3699) so physics still settles.
  x: (n.x !== undefined && n.x !== null) ? n.x : 30 * Math.sqrt(i) * Math.cos(i * 2.4),
  y: (n.y !== undefined && n.y !== null) ? n.y : 30 * Math.sqrt(i) * Math.sin(i * 2.4),
  community: n.community, community_name: n.community_name,
  source_file: n.source_file, file_type: n.file_type, degree: n.degree,
  member_count: n.member_count,
}})));

const edgesDS = new vis.DataSet(RAW_EDGES.map((e, i) => ({{
  id: i, from: e.from, to: e.to,
  label: '',
  title: e.title,
  dashes: e.dashes,
  width: e.width,
  color: e.color,
  arrows: {{ to: {{ enabled: {_arrow_default} }} }},
}})));

const container = document.getElementById('graph');
const network = new vis.Network(container, {{ nodes: nodesDS, edges: edgesDS }}, {{
  physics: {{
    enabled: {physics_enabled},
    solver: 'forceAtlas2Based',
    forceAtlas2Based: {{
      gravitationalConstant: -60,
      centralGravity: 0.005,
      springLength: 120,
      springConstant: 0.08,
      damping: 0.4,
      avoidOverlap: 0.8,
    }},
    stabilization: {{ iterations: {stab_iters}, fit: true }},
  }},
  interaction: {{
    hover: true,
    tooltipDelay: 100,
    navigationButtons: false,
    keyboard: false,
  }},
  nodes: {{ shape: 'dot', borderWidth: 1.5 }},
  edges: {{ smooth: {{ type: 'continuous', roundness: 0.2 }}, selectionWidth: 3 }},
}});
{_POSITION_CACHE_JS}
{lean_js}

// Theme toggle (#3894): Light / Dark / System, persisted in localStorage.
const THEME_KEY = 'graphify-theme';
const themeMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
let themeLabelColor = '#ffffff';  // matches the per-node font color set in Python
function themePref() {{
  let p = null;
  try {{ p = localStorage.getItem(THEME_KEY); }} catch (e) {{}}
  return (p === 'light' || p === 'dark' || p === 'system') ? p : null;
}}
function applyTheme(pref) {{
  const t = pref === 'light' ? 'light' : (pref === 'system' && themeMQ && themeMQ.matches) ? 'light' : 'dark';
  const root = document.documentElement;
  if (!root) return;
  root.setAttribute('data-theme', t);
  document.querySelectorAll('[data-theme-choice]').forEach(b => {{
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === (pref || 'dark')));
  }});
  const labelColor = getComputedStyle(root).getPropertyValue('--node-label').trim();
  if (labelColor && labelColor !== themeLabelColor) {{
    themeLabelColor = labelColor;
    nodesDS.update(nodesDS.get().map(n => ({{ id: n.id, font: Object.assign({{}}, n.font, {{ color: labelColor }}) }})));
  }}
}}
document.querySelectorAll('[data-theme-choice]').forEach(b => {{
  b.addEventListener('click', () => {{
    const pref = b.dataset.themeChoice;
    try {{ localStorage.setItem(THEME_KEY, pref); }} catch (e) {{}}
    applyTheme(pref);
  }});
}});
if (themeMQ) {{
  const onSchemeChange = () => {{ if (themePref() === 'system') applyTheme('system'); }};
  if (themeMQ.addEventListener) themeMQ.addEventListener('change', onSchemeChange);
  else if (themeMQ.addListener) themeMQ.addListener(onSchemeChange);
}}
applyTheme(themePref());

{stabilization_handler}
{baked_fit_js}
{_ARROW_HOVER_JS if defer_arrows else ''}

function showInfo(nodeId) {{
  const n = nodesDS.get(nodeId);
  if (!n) return;
  const neighborIds = network.getConnectedNodes(nodeId);
  const neighborItems = neighborIds.map(nid => {{
    const nb = nodesDS.get(nid);
    const color = nb ? nb.color.background : '#555';
    return `<span class="neighbor-link" style="border-left-color:${{esc(color)}}" data-nid="${{esc(nid)}}">${{esc(nb ? nb.label : nid)}}</span>`;
  }}).join('');
  const isMetaNode = !n.file_type && !n.source_file;
  let html = `<div class="field"><b>${{esc(n.label)}}</b></div>`;
  if (!isMetaNode) {{
    html += `<div class="field">Type: ${{esc(n.file_type || 'unknown')}}</div>`;
  }}
  html += `<div class="field">Community: ${{esc(n.community_name || '')}}</div>`;
  if (!isMetaNode) {{
    html += `<div class="field">Source: ${{esc(n.source_file || '-')}}</div>`;
  }} else if (n.member_count !== undefined && n.member_count !== null) {{
    html += `<div class="field">Members: ${{esc(n.member_count)}}</div>`;
  }}
  html += `<div class="field">Degree: ${{n.degree}}</div>`;
  if (neighborIds.length) {{
    html += `<div class="field" style="margin-top:8px;color:var(--text-2);font-size:11px">Neighbors (${{neighborIds.length}})</div><div id="neighbors-list">${{neighborItems}}</div>`;
  }}
  document.getElementById('info-content').innerHTML = html;
}}

function focusNode(nodeId) {{
  network.focus(nodeId, {{ scale: 1.4, animation: true }});
  network.selectNodes([nodeId]);
  showInfo(nodeId);
}}

// Neighbor links use a data attribute + one delegated listener rather than an
// inline onclick. A node id/label sourced from a document or a scraped URL
// (graphify add) can contain a double-quote; dropping the stringified id
// unescaped into a quoted onclick both broke every link and allowed a hostile
// source to inject an event handler into the local report (stored XSS, #1838).
// esc() on data-nid keeps the value inside the attribute; the listener reads it
// back verbatim. Bound to document so it survives the innerHTML rebuild that
// recreates #neighbors-list on each showInfo().
document.addEventListener('click', e => {{
  const el = e.target.closest('.neighbor-link');
  if (el && el.dataset.nid !== undefined) focusNode(el.dataset.nid);
}});

// Sidebar tooltips reuse vis-network's .vis-tooltip style and 100ms tooltipDelay.
// Names get one only when CSS ellipsis truncates them (the full text is still in
// the DOM); counts always get one, to say what the number is. Text is set with
// textContent only (labels are untrusted). Delegated on document so rows rebuilt
// later (search results, showInfo()) are covered.
const sidebarTip = document.createElement('div');
sidebarTip.className = 'vis-tooltip';
sidebarTip.style.cssText = 'white-space: normal; max-width: 360px; overflow-wrap: break-word;';
document.body.appendChild(sidebarTip);
let sidebarTipTimer = null;
let sidebarTipEl = null;    // element whose text the tooltip shows
let sidebarTipZone = null;  // element the pointer must leave to hide it
function hideSidebarTip() {{
  clearTimeout(sidebarTipTimer);
  sidebarTip.style.visibility = 'hidden';
  sidebarTip.textContent = '';
  sidebarTipEl = sidebarTipZone = null;
}}
document.addEventListener('mouseover', e => {{
  const zone = e.target.closest && e.target.closest('.legend-count, .legend-item, .search-item, .neighbor-link');
  // Anywhere on a legend row except its count (dot, checkbox, gaps, padding)
  // stands for the row's name, so moving within the row never re-triggers it.
  const el = zone && zone.classList.contains('legend-item') ? zone.querySelector('.legend-label') : zone;
  if (!el || el === sidebarTipEl) return;
  hideSidebarTip();
  const isCount = el.classList.contains('legend-count');
  if (!isCount && el.scrollWidth <= el.clientWidth) return;
  const text = isCount ? `${{el.textContent}} ${{el.textContent === '1' ? 'node' : 'nodes'}}` : el.textContent;
  sidebarTipEl = el;
  sidebarTipZone = zone;
  const x = e.clientX, y = e.clientY;
  sidebarTipTimer = setTimeout(() => {{
    sidebarTip.textContent = text;
    sidebarTip.style.left = sidebarTip.style.top = '0px';  // measure at full max-width
    sidebarTip.style.visibility = 'visible';
    const w = sidebarTip.offsetWidth, h = sidebarTip.offsetHeight;
    sidebarTip.style.left = Math.max(4, Math.min(x + 12, window.innerWidth - w - 4)) + 'px';
    sidebarTip.style.top = (y + 16 + h > window.innerHeight ? Math.max(4, y - h - 8) : y + 16) + 'px';
  }}, 100);
}});
document.addEventListener('mouseout', e => {{
  if (sidebarTipZone && !sidebarTipZone.contains(e.relatedTarget)) hideSidebarTip();
}});
// A click rebuilds or hides the row (showInfo(), search pick) without a mouseout.
document.addEventListener('mousedown', hideSidebarTip);

// Track hovered node — hover detection is more reliable than click params
let hoveredNodeId = null;
network.on('hoverNode', params => {{
  hoveredNodeId = params.node;
  container.style.cursor = 'pointer';
}});
network.on('blurNode', () => {{
  hoveredNodeId = null;
  container.style.cursor = 'default';
}});
container.addEventListener('click', () => {{
  if (hoveredNodeId !== null) {{
    showInfo(hoveredNodeId);
    network.selectNodes([hoveredNodeId]);
  }}
}});
network.on('click', params => {{
  if (params.nodes.length > 0) {{
    showInfo(params.nodes[0]);
  }} else if (hoveredNodeId === null) {{
    document.getElementById('info-content').innerHTML = '<span class="empty">Click a node to inspect it</span>';
  }}
}});

const searchInput = document.getElementById('search');
const searchResults = document.getElementById('search-results');
searchInput.addEventListener('input', () => {{
  const q = searchInput.value.toLowerCase().trim();
  searchResults.innerHTML = '';
  if (!q) {{ searchResults.style.display = 'none'; return; }}
  const matches = RAW_NODES.filter(n => n.label.toLowerCase().includes(q)).slice(0, 20);
  if (!matches.length) {{ searchResults.style.display = 'none'; return; }}
  searchResults.style.display = 'block';
  matches.forEach(n => {{
    const el = document.createElement('div');
    el.className = 'search-item';
    el.textContent = n.label;
    el.style.borderLeft = `3px solid ${{n.color.background}}`;
    el.style.paddingLeft = '8px';
    el.onclick = () => {{
      network.focus(n.id, {{ scale: 1.5, animation: true }});
      network.selectNodes([n.id]);
      showInfo(n.id);
      searchResults.style.display = 'none';
      searchInput.value = '';
    }};
    searchResults.appendChild(el);
  }});
}});
document.addEventListener('click', e => {{
  if (!searchResults.contains(e.target) && e.target !== searchInput)
    searchResults.style.display = 'none';
}});

const hiddenCommunities = new Set();

const selectAllCb = document.getElementById('select-all-cb');

function updateSelectAllState() {{
  const total = LEGEND.length;
  const hidden = hiddenCommunities.size;
  selectAllCb.checked = hidden === 0;
  selectAllCb.indeterminate = hidden > 0 && hidden < total;
}}

function toggleAllCommunities(hide) {{
  document.querySelectorAll('.legend-item').forEach(item => {{
    hide ? item.classList.add('dimmed') : item.classList.remove('dimmed');
  }});
  document.querySelectorAll('.legend-cb').forEach(cb => {{
    cb.checked = !hide;
  }});
  LEGEND.forEach(c => {{
    if (hide) hiddenCommunities.add(c.cid); else hiddenCommunities.delete(c.cid);
  }});
  const updates = RAW_NODES.map(n => ({{ id: n.id, hidden: hide }}));
  nodesDS.update(updates);
  updateSelectAllState();
}}

const legendEl = document.getElementById('legend');
LEGEND.forEach(c => {{
  const item = document.createElement('div');
  item.className = 'legend-item';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'legend-cb';
  cb.checked = true;
  cb.addEventListener('change', (e) => {{
    e.stopPropagation();
    if (cb.checked) {{
      hiddenCommunities.delete(c.cid);
      item.classList.remove('dimmed');
    }} else {{
      hiddenCommunities.add(c.cid);
      item.classList.add('dimmed');
    }}
    const updates = RAW_NODES
      .filter(n => n.community === c.cid)
      .map(n => ({{ id: n.id, hidden: !cb.checked }}));
    nodesDS.update(updates);
    updateSelectAllState();
  }});
  item.innerHTML = `<div class="legend-dot" style="background:${{c.color}}"></div>
    <span class="legend-label">${{c.label}}</span>
    <span class="legend-count">${{c.count}}</span>`;
  item.prepend(cb);
  item.onclick = (e) => {{
    if (e.target === cb) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  }};
  legendEl.appendChild(item);
}});
{_UX_JS if lean_gestures else ''}
</script>"""


def _html_document_title(output_path: str) -> str:
    """Return a portable label for the graph.html <title>.

    Tracked artifacts must not embed the generator host absolute path
    (regression of #433; reported again as #2598 on Windows). Keep from the
    configured output-dir bare name (``graphify-out`` / ``GRAPHIFY_OUT``
    basename) onward — portable in every case; otherwise fall back to a
    cwd-relative label, and finally the filename only.
    """
    from graphify.paths import GRAPHIFY_OUT_NAME

    raw = str(output_path).replace("\\", "/")
    # Drop Windows drive prefix so Path parts are comparable on any OS.
    if len(raw) >= 3 and raw[1] == ":" and raw[0].isalpha() and raw[2] == "/":
        raw = raw[2:]  # "/Users/..." style after drive strip
    p = Path(raw)

    parts = list(Path(raw).parts)
    # Path("C:/Users/..") on POSIX may keep "C:" as first part — strip it.
    if parts and len(parts[0]) == 2 and parts[0][1] == ":" and parts[0][0].isalpha():
        parts = parts[1:]
    # Prefer keeping from the output-dir marker onward: portable in every
    # case, whereas a cwd-relative path still leaks host/user segments when
    # the graph is built from a directory ABOVE the project (#2598 follow-up).
    marker = GRAPHIFY_OUT_NAME
    for i, part in enumerate(parts):
        if part == marker or part.startswith("graphify-out"):
            return "/".join(parts[i:])

    # No standard out-dir marker (fully custom output path): fall back to a
    # cwd-relative label when the target is under cwd, else the bare filename.
    try:
        resolved = p if p.is_absolute() else (Path.cwd() / p)
        rel = resolved.resolve().relative_to(Path.cwd().resolve())
        label = rel.as_posix()
        if label and label != ".":
            return label
    except (ValueError, OSError, RuntimeError):
        pass

    name = p.name
    return name if name else "graph.html"

def to_html(
    G: nx.Graph,
    communities: dict[int, list[str]],
    output_path: str,
    community_labels: dict[int, str] | None = None,
    member_counts: dict[int, int] | None = None,
    node_limit: int | None = None,
    learning_overlay: dict | None = None,
) -> bool:
    """Generate an interactive vis.js HTML visualization of the graph.

    Features: node size by degree, click-to-inspect panel, search box,
    community filter, physics clustering by community, confidence-styled edges.
    Raises ValueError if graph exceeds MAX_NODES_FOR_VIZ.

    If member_counts is provided (aggregated community view), node sizes are
    based on community member counts rather than graph degree.

    If node_limit is set and the graph exceeds it, automatically builds an
    aggregated community-level meta-graph instead of raising ValueError.

    Returns True when the output was written. Returns False when an aggregated
    view would contain fewer than two communities and is intentionally skipped.
    """
    limit = node_limit if node_limit is not None else _viz_node_limit()
    if G.number_of_nodes() > limit:
        if node_limit is not None:
            # Build aggregated community meta-graph
            from collections import Counter as _Counter
            import networkx as _nx
            print(f"Graph has {G.number_of_nodes()} nodes (above {limit} limit). Building aggregated community view...")
            node_to_community = {nid: cid for cid, members in communities.items() for nid in members}
            meta = _nx.Graph()
            for cid, members in communities.items():
                meta.add_node(str(cid), label=(community_labels or {}).get(cid, f"Community {cid}"))
            edge_counts = _Counter()
            for u, v in G.edges():
                cu, cv = node_to_community.get(u), node_to_community.get(v)
                if cu is not None and cv is not None and cu != cv:
                    edge_counts[(min(cu, cv), max(cu, cv))] += 1
            for (cu, cv), w in edge_counts.items():
                meta.add_edge(str(cu), str(cv), weight=w,
                              relation=f"{w} cross-community edges", confidence="AGGREGATED")
            if meta.number_of_nodes() <= 1:
                print("Single community - aggregated view not useful. Skipping graph.html.")
                return False
            meta_communities = {cid: [str(cid)] for cid in communities}
            mc = {cid: len(members) for cid, members in communities.items()}
            # Remap hyperedges from semantic node IDs to community IDs
            raw_hyperedges = G.graph.get("hyperedges", [])
            if raw_hyperedges:
                remapped = []
                for he in raw_hyperedges:
                    he_members = he.get("nodes", [])
                    comm_ids, seen = [], set()
                    for nid in he_members:
                        c = node_to_community.get(nid)
                        if c is None:
                            continue
                        s = str(c)
                        if s in seen:
                            continue
                        seen.add(s)
                        comm_ids.append(s)
                    if len(comm_ids) < 2:
                        continue
                    remapped.append({
                        "id": he.get("id", ""),
                        "label": he.get("label") or he.get("relation", "").replace("_", " "),
                        "nodes": comm_ids,
                    })
                meta.graph["hyperedges"] = remapped
            written = to_html(meta, meta_communities, output_path,
                              community_labels=community_labels, member_counts=mc)
            if not written:
                return False
            print(f"graph.html written (aggregated: {meta.number_of_nodes()} community nodes, {meta.number_of_edges()} cross-community edges)")
            print("Tip: run with --obsidian for full node-level detail.")
            return True
        raise ValueError(
            f"Graph has {G.number_of_nodes()} nodes - too large for HTML viz "
            f"(limit: {limit}). Use --no-viz, raise GRAPHIFY_VIZ_NODE_LIMIT, "
            f"or reduce input size."
        )

    node_community = _node_community_map(communities)
    degree = dict(G.degree())
    max_deg = max(degree.values(), default=1) or 1
    max_mc = (max(member_counts.values(), default=1) or 1) if member_counts else 1

    # Work-memory overlay (derived sidecar). When not passed explicitly, load it
    # best-effort from the sibling .graphify_learning.json next to the output
    # graph.html (which lives beside graph.json). Empty/missing => no learning
    # fields, so the un-annotated render is byte-identical to pre-feature.
    if learning_overlay is None:
        learning_overlay = {}
        try:
            from graphify.reflect import load_learning_overlay as _llo
            learning_overlay = _llo(Path(output_path))
        except Exception:
            learning_overlay = {}
    # Status -> ring color. preferred=green, contested=amber. Tentative gets no
    # ring (it's not yet trustworthy enough to highlight in the map).
    _RING = {"preferred": "#22c55e", "contested": "#f59e0b"}

    # Build nodes list for vis.js
    vis_nodes = []
    for node_id, data in G.nodes(data=True):
        cid = node_community.get(node_id, 0)
        color = COMMUNITY_COLORS[cid % len(COMMUNITY_COLORS)]
        label = sanitize_label(data.get("label", node_id))
        deg = degree.get(node_id, 1)
        if member_counts:
            mc = member_counts.get(cid, 1)
            size = 10 + 30 * (mc / max_mc)
            font_size = 12
        else:
            size = 10 + 30 * (deg / max_deg)
            # Only show label for high-degree nodes by default; others show on hover
            font_size = 12 if deg >= max_deg * 0.15 else 0
        node = {
            "id": node_id,
            "label": label,
            # Keep the community colour when selected or hovered, and accent with a
            # white border ring. The old highlight repainted the node #ffffff, which
            # made a selected/hovered cluster look washed out (#perf L13).
            "color": {
                "background": color,
                "border": color,
                "highlight": {"background": color, "border": "#ffffff"},
                "hover": {"background": color, "border": "#ffffff"},
            },
            "size": round(size, 1),
            "font": {"size": font_size, "color": "#ffffff"},
            # Tooltip `title` is a STRING, which vis-network renders via
            # Popup.setText -> `frame.innerText = t` (verified in the pinned
            # 9.1.6 bundle: the only non-Element branch is innerText, and the
            # bundle has zero `innerHTML = <var>` sinks). So raw special chars
            # are shown literally and must NOT be html-escaped here or the user
            # sees `&amp;`/`&lt;` in the tooltip (#3664/#3686). This is the
            # #1838 stored-XSS boundary: never pass an HTMLElement as `title`,
            # and do not change the vis-network pin below without re-checking
            # Popup rendering (the test_export version-pin guard enforces this).
            "title": label,
            "community": cid,
            "community_name": sanitize_label((community_labels or {}).get(cid, f"Community {cid}")),
            "source_file": sanitize_label(str(data.get("source_file") or "")),
            "file_type": data.get("file_type", ""),
            "degree": deg,
        }
        if member_counts:
            node["member_count"] = member_counts.get(cid, len(communities.get(cid, [])))
        # Pre-baked positions (#perf L10): when the input graph carries stabilized
        # x/y (e.g. produced by `harness/bake.mjs` or a future `--bake` step), ship
        # them so the first open skips the on-load solver. Capability is untouched:
        # nodes/edges/communities/direction/confidence all survive; only the
        # recompute cost moves offline. Absent -> the spiral seed + solver (as before).
        if data.get("x") is not None and data.get("y") is not None:
            node["x"] = data["x"]
            node["y"] = data["y"]
        # Conditional learning fields — only present for annotated nodes, so
        # un-annotated output keeps the exact pre-feature node dict shape.
        entry = learning_overlay.get(str(node_id)) if learning_overlay else None
        if entry:
            status = sanitize_label(str(entry.get("status", "")))
            stale = bool(entry.get("stale"))
            node["learning_status"] = status
            node["learning_stale"] = stale
            ring = _RING.get(status)
            if ring:
                # Status-colored ring via the border; stale => desaturated +
                # dashed (vis.js supports per-node `shapeProperties.borderDashes`).
                if stale:
                    ring = "#9ca3af"
                    node["shapeProperties"] = {"borderDashes": [4, 4]}
                node["borderWidth"] = 3
                # Selection keeps the community fill here too; the status ring is
                # what must stay legible, so it stays the highlight border.
                node["color"] = {
                    "background": color, "border": ring,
                    "highlight": {"background": color, "border": ring},
                    "hover": {"background": color, "border": ring},
                }
            # Lesson line appended to the hover title.
            if status == "contested":
                lesson = f"Lesson: contested (useful {entry.get('uses', 0)} / dead-end {entry.get('neg', 0)})"
            elif status == "preferred":
                lesson = f"Lesson: preferred source ({entry.get('uses', 0)} useful, score={entry.get('score', 0)})"
            else:
                lesson = f"Lesson: {status} ({entry.get('uses', 0)} useful)"
            if stale:
                lesson += " [code changed — re-verify]"
            node["title"] = f"{label}\n{sanitize_label(lesson)}"
        vis_nodes.append(node)

    # Build edges list. Restore original edge direction from _src/_tgt
    # (stashed by build.py for exactly this reason): undirected NetworkX
    # canonicalizes endpoint order, which would otherwise flip the arrow
    # for `calls` and `rationale_for` in the rendered graph (#563).
    vis_edges = []
    for u, v, data in G.edges(data=True):
        confidence = data.get("confidence", "EXTRACTED")
        relation = data.get("relation", "")
        true_src = data.get("_src", u)
        true_tgt = data.get("_tgt", v)
        vis_edges.append({
            "from": true_src,
            "to": true_tgt,
            "label": relation,
            "title": sanitize_label(f"{relation} [{confidence}]"),
            "dashes": confidence != "EXTRACTED",
            "width": 2 if confidence == "EXTRACTED" else 1,
            "color": {"opacity": 0.7 if confidence == "EXTRACTED" else 0.35},
            "confidence": confidence,
        })

    # Build community legend data
    legend_data = []
    for cid in sorted((community_labels or {}).keys()):
        color = COMMUNITY_COLORS[cid % len(COMMUNITY_COLORS)]
        lbl = _html.escape(sanitize_label((community_labels or {}).get(cid, f"Community {cid}")))
        n = member_counts.get(cid, len(communities.get(cid, []))) if member_counts else len(communities.get(cid, []))
        legend_data.append({"cid": cid, "color": color, "label": lbl, "count": n})

    # Escape every `<` as < so embedded JSON cannot break out of the <script>
    # element. Escaping only `</` is not enough: an unclosed `<!--` then a later
    # `<script` in a label drive the HTML tokenizer into script-data-double-escaped
    # state, where the real `</script>` no longer closes the tag and the page goes
    # blank (#4124). `<` round-trips through JSON.parse, so labels render unchanged.
    def _js_safe(obj) -> str:
        return json.dumps(obj).replace("<", "\\u003c")

    nodes_json = _js_safe(vis_nodes)
    edges_json = _js_safe(vis_edges)
    legend_json = _js_safe(legend_data)
    hyperedges_json = _js_safe(getattr(G, "graph", {}).get("hyperedges", []))
    # Pre-baked positions (#perf L10): if every node carries stabilized x/y, ship
    # them and skip the on-load solver entirely. Physics off from the first frame.
    _baked_all = bool(vis_nodes) and all(
        n.get("x") is not None and n.get("y") is not None for n in vis_nodes
    )
    physics_enabled = "false" if _baked_all else "true"
    stab_iters = "0" if _baked_all else "200"
    stabilization_handler = "" if _baked_all else (
        "network.once('stabilizationIterationsDone', () => {"
        " network.setOptions({ physics: { enabled: false } });"
        " _savePositions(); });"
    )
    baked_fit_js = "try { network.fit({ animation: false }); } catch (e) {}" if _baked_all else ""
    title = _html.escape(sanitize_label(_html_document_title(output_path)))
    stats = f"{G.number_of_nodes()} nodes &middot; {G.number_of_edges()} edges &middot; {len(communities)} communities"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>graphify - {title}</title>
<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"
        integrity="sha384-Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1"
        crossorigin="anonymous"
        onerror="var s=document.createElement('script');s.src='vis-network.min.js';document.head.appendChild(s);"></script>
{_html_styles()}
<script id="graphify-theme-init">
// Apply the saved theme before first paint (#3894). No saved choice keeps the
// historical dark look; "system" follows prefers-color-scheme.
(function () {{
  var pref = null;
  try {{ pref = localStorage.getItem('graphify-theme'); }} catch (e) {{}}
  var t = pref === 'light' ? 'light'
    : pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light'
    : 'dark';
  document.documentElement.setAttribute('data-theme', t);
}})();
</script>
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <div id="theme-wrap" role="group" aria-label="Theme">
    <button type="button" data-theme-choice="light">Light</button>
    <button type="button" data-theme-choice="dark">Dark</button>
    <button type="button" data-theme-choice="system">System</button>
  </div>
  <div id="search-wrap">
    <input id="search" type="text" placeholder="Search nodes..." autocomplete="off">
    <div id="search-results"></div>
  </div>
  <div id="info-panel">
    <h3>Node Info</h3>
    <div id="info-content"><span class="empty">Click a node to inspect it</span></div>
  </div>
  <div id="legend-wrap">
    <h3>Communities</h3>
    <div id="legend-controls">
      <label><input type="checkbox" id="select-all-cb" checked onchange="toggleAllCommunities(!this.checked)">Select All</label>
    </div>
    <div id="legend"></div>
  </div>
  <div id="stats">{stats}</div>
</div>
{_html_script(nodes_json, edges_json, legend_json, defer_arrows=G.number_of_edges() > ARROW_DEFER_EDGE_THRESHOLD, lean_gestures=G.number_of_nodes() > LEAN_GESTURE_NODE_THRESHOLD, baked=_baked_all)}
{_hyperedge_script(hyperedges_json)}
</body>
</html>"""

    write_text_atomic(output_path, html)
    return True
