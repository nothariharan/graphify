"""Edge-cost variants of the lean-gesture build.

Hiding edges during a gesture is what the user rejected (lines vanish while panning
or zooming). The alternative is to keep them drawn but make each edge cheap for the
length of the gesture: vis draws `smooth: continuous` edges as beziers, which costs
far more than a straight `lineTo`. These variants lean the edges (straight + thinner)
by writing onto the edge instances, the same way the node border lean works, and
restore them on release.

  python harness/mk_edge_variants.py

Writes variants/edge-<name>.html from variants/base-ours-v5.html.
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v5.html")

STATIC_STRAIGHT_OLD = "edges: { smooth: { type: 'continuous', roundness: 0.2 }, selectionWidth: 3 },"
STATIC_STRAIGHT_NEW = "edges: { smooth: false, selectionWidth: 3 },"

# Appended after the existing lean-gesture block. Registering more listeners is fine:
# vis does not replace handlers.
#
# Why `_line` and not `options.smooth`: vis picks the curve implementation class once
# in `updateEdgeType()` (called from setOptions) and caches it on `edge.edgeType`.
# Writing `options.smooth = false` changes the data but the draw still goes through the
# cached bezier class (verified: 3876/3876 edges reported smooth=false mid-gesture and
# still emitted zero `lineTo` calls). Swapping the instance's `_line` for the straight
# one that vis's own "no smooth" class uses (a plain moveTo/lineTo, same shadow and
# stroke handling) needs no class construction, no dataset write and no setOptions.
DYNAMIC_EDGE_LEAN = """
// Lean the EDGES during a gesture (#perf): keep them visible, draw them straight while
// the pointer is moving. vis renders `smooth` edges as beziers, which cost far more per
// frame than straight segments, and hiding them outright is not acceptable - the graph
// must not appear to fall apart while you move it. Restored on release.
(function () {
  function _straightLine(g, t) {
    g.beginPath();
    g.moveTo(this.fromPoint.x, this.fromPoint.y);
    g.lineTo(this.toPoint.x, this.toPoint.y);
    this.enableShadow(g, t);
    g.stroke();
    this.disableShadow(g, t);
  }
  let _applied = false;
  function _leanEdges(on) {
    if (on === _applied) return;
    _applied = on;
    try {
      const es = network.body && network.body.edges;
      if (!es) return;
      for (const id in es) {
        const et = es[id] && es[id].edgeType;
        if (!et) continue;
        if (on) {
          if (!et.__leanLine) { et.__leanLine = et._line; et._line = _straightLine; }
        } else if (et.__leanLine) {
          et._line = et.__leanLine;
          delete et.__leanLine;
        }
      }
    } catch (err) {}
  }
  network.on('dragStart', function () { _leanEdges(true); });
  network.on('dragEnd', function () { _leanEdges(false); try { network.redraw(); } catch (e) {} });
  let t = null;
  network.on('zoom', function () {
    _leanEdges(true);
    clearTimeout(t);
    t = setTimeout(function () { _leanEdges(false); try { network.redraw(); } catch (e) {} }, 180);
  });
})();
"""

s = io.open(SRC, encoding="utf-8").read()

BATCH_REAL = """
// Batched gesture draw for edges (#perf). vis issues one ctx.stroke() per edge, and on
// this graph that is 3876 strokes (~30ms) every frame. Grouping edges by the colour,
// dash pattern and width they are drawn with and stroking each group once cuts it to a
// few hundred strokes for the same pixels. Every edge is still drawn, in its own colour,
// with its dashes, and the endpoints are read live each frame (edgeType.fromPoint IS the
// node object), so edges still follow a node being dragged.
(function () {
  let _installed = false, _drawn = false, _groups = null, _ctx = null, _zt = null, _errors = 0;

  function _scratch() {
    try { return document.createElement('canvas').getContext('2d'); } catch (e) { return null; }
  }

  function _dashOf(t) {
    const d = t.dashes;
    if (d === false || d === null || d === undefined) return null;
    if (d === true) return [5, 5];
    return d;
  }

  function _build() {
    const body = network.body;
    const es = body && body.edges;
    if (!es) return false;
    if (!_ctx) _ctx = (body.renderer && body.renderer.ctx) || _scratch();
    const map = new Map();
    for (const id in es) {
      const e = es[id];
      if (!e || !e.connected || !e.edgeType) continue;
      let t = null;
      try { t = e.getFormattingValues(); } catch (err) { continue; }
      if (!t || t.hidden) continue;
      let col = null;
      try { col = e.edgeType.getColor(_ctx, t); } catch (err) { continue; }
      if (typeof col !== 'string') continue;                 // gradient/exotic: let vis draw it
      const dash = _dashOf(t);
      const key = col + '|' + (dash ? dash.join(',') : '') + '|' + t.width;
      let grp = map.get(key);
      if (!grp) map.set(key, grp = { col: col, w: t.width, dash: dash, ets: [] });
      grp.ets.push(e.edgeType);
    }
    _groups = [];
    for (const grp of map.values()) _groups.push(grp);
    return _groups.length > 0;
  }

  function _drawAll(g) {
    const groups = _groups;
    if (!groups || !g) return;
    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      const ets = grp.ets;
      g.strokeStyle = grp.col;
      g.lineWidth = grp.w;
      if (grp.dash) { g.save(); g.lineCap = 'round'; g.setLineDash(grp.dash); }
      g.beginPath();
      for (let j = 0; j < ets.length; j++) {
        const et = ets[j];
        g.moveTo(et.fromPoint.x, et.fromPoint.y);
        g.lineTo(et.toPoint.x, et.toPoint.y);
      }
      g.stroke();
      if (grp.dash) g.restore();
    }
  }

  function _install() {
    if (_installed) return true;
    if (!_build()) return false;
    const es = network.body.edges;
    for (const id in es) {
      const et = es[id] && es[id].edgeType;
      if (!et || et.__leanBatch) continue;
      const orig = et.drawLine;
      et.__leanBatch = orig;
      et.drawLine = function (ctx, tv, sel, hov, via) {
        if (_drawn) return;
        _drawn = true;
        try { _drawAll(ctx); return; } catch (err) {
          _errors++;
          if (_errors > 2) _uninstall();
        }
        orig.call(this, ctx, tv, sel, hov, via);
      };
    }
    _installed = true;
    return true;
  }

  function _uninstall() {
    try {
      const es = network.body && network.body.edges;
      for (const id in es) {
        const et = es[id] && es[id].edgeType;
        if (!et || !et.__leanBatch) continue;
        delete et.drawLine;            // back to the prototype implementation
        delete et.__leanBatch;
      }
    } catch (err) {}
    _installed = false;
    _groups = null;
    _drawn = false;
  }

  network.on('afterDrawing', function () { _drawn = false; });
  network.on('dragStart', function () { _drawn = false; _install(); });
  network.on('dragging', function () { _drawn = false; if (!_installed) _install(); });
  network.on('dragEnd', function () { _uninstall(); try { network.redraw(); } catch (e) {} });
  network.on('zoom', function () {
    _drawn = false;
    _install();
    clearTimeout(_zt);
    _zt = setTimeout(function () { _uninstall(); try { network.redraw(); } catch (e) {} }, 180);
  });

  // exposed for the perf probes only
  Object.defineProperty(window, '__edgeBatchInfo', {
    get: function () { return { installed: _installed, groups: _groups ? _groups.length : 0 }; },
  });
})();
"""

marker = "\n// Theme toggle"
if marker in s:
    a, m, b = s.partition(marker)
    out = os.path.join(LAB, "variants", "edge-batch-real.html")
    io.open(out, "w", encoding="utf-8", newline="").write(a + "\n" + BATCH_REAL + m + b)
    print("edge-batch-real.html           (production shape: colour/dash/width grouped strokes)")
else:
    print("!! batch real: theme marker not found")

# 4) CEILING TEST (not shippable, intentionally unfaithful on colour): replace every
# per-edge stroke with one batched path. If a single stroke for all 3876 edges does not
# buy much, colour-grouped batching is not worth writing.
BATCH_CEILING = """
// CEILING TEST ONLY: draw every edge as one path, on the first edge draw of each frame.
(function () {
  let _drawn = false;
  network.on('afterDrawing', function () { _drawn = false; });
  function _install() {
    const es = network.body && network.body.edges;
    if (!es) return;
    for (const id in es) {
      const et = es[id] && es[id].edgeType;
      if (!et || et.__batch) continue;
      const orig = et.drawLine;
      et.__batch = orig;
      et.drawLine = function (g, t, e, A, C) {
        if (_drawn) return;
        _drawn = true;
        g.strokeStyle = this.getColor(g, t);
        g.lineWidth = t.width;
        g.beginPath();
        const all = network.body.edges;
        for (const k in all) {
          const ed = all[k];
          if (!ed || !ed.connected || ed.options.hidden) continue;
          const d = ed.edgeType;
          g.moveTo(d.fromPoint.x, d.fromPoint.y);
          g.lineTo(d.toPoint.x, d.toPoint.y);
        }
        g.stroke();
      };
    }
  }
  network.once('afterDrawing', function () { _install(); });
  _install();
})();
"""
marker = "\n// Theme toggle"
if marker in s:
    a, m, b = s.partition(marker)
    out = os.path.join(LAB, "variants", "edge-batch-ceiling.html")
    io.open(out, "w", encoding="utf-8", newline="").write(a + "\n" + BATCH_CEILING + m + b)
    print("edge-batch-ceiling.html        (NOT shippable: all edges one colour, one stroke)")
else:
    print("!! batch ceiling: theme marker not found")

# 1) everything visible, everything curved (the v5 baseline already is this)
out = os.path.join(LAB, "variants", "edge-visible-curved.html")
io.open(out, "w", encoding="utf-8", newline="").write(s)
print("edge-visible-curved.html      (v5 baseline: edges drawn, curved)")

# 2) edges visible, straight and thin for the whole page (upper bound for the lever)
if STATIC_STRAIGHT_OLD not in s:
    print("!! static straight: anchor not found")
else:
    out = os.path.join(LAB, "variants", "edge-straight-static.html")
    io.open(out, "w", encoding="utf-8", newline="").write(s.replace(STATIC_STRAIGHT_OLD, STATIC_STRAIGHT_NEW, 1))
    print("edge-straight-static.html     (curved -> straight always: the ceiling test)")

# 3) the shippable shape: curved at rest, straight + thin while moving
anchor = "network.on('zoom', function () {\n  _setLean(true);"
if anchor not in s:
    anchor = "network.on('zoom', function () {"
if anchor not in s:
    print("!! dynamic lean: zoom handler anchor not found")
else:
    head, sep, tail = s.partition(anchor)
    # put the edge-lean block at the very end of the lean script
    marker = "\n// Theme toggle"
    if marker in tail:
        a, m, b = s.partition(marker)
        s2 = a + "\n" + DYNAMIC_EDGE_LEAN + m + b
        out = os.path.join(LAB, "variants", "edge-lean-dynamic.html")
        io.open(out, "w", encoding="utf-8", newline="").write(s2)
        print("edge-lean-dynamic.html        (curved at rest, straight+thin in motion)")
    else:
        print("!! dynamic lean: theme marker not found")
