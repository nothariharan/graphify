"""Build the L21 scratch variant: the node border is the frame's biggest cost.

Measured on rsl: the resting frame is ~86 ms, ~17 ms of that is inside vis's per-node
JavaScript, and the node *borders* (1886 hairline strokes) are ~57 ms of it. The exporter
paints every node's border in the same colour as its fill, so the border only makes the
dot bigger by borderWidth/2. Drawing that as a slightly larger fill is the same picture
with one fill instead of a fill plus a hairline stroke.

This variant:
  - sets the global borderWidth to 0,
  - grows every node's size by 1.5 (so the disc keeps its outer edge),
  - puts the 1.5 border back on the nodes that are hovered or selected, where the border
    is WHITE (color.hover.border / color.highlight.border) and therefore visible.

  python harness/mk_l21.py
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v10.html")
DST = os.path.join(LAB, "variants", "L21-noborder.html")

s = io.open(SRC, encoding="utf-8").read()

old = "nodes: { shape: 'dot', borderWidth: 1.5 },"
assert s.count(old) == 1, ("nodes options", s.count(old))
s = s.replace(old, "nodes: { shape: 'dot', borderWidth: 0 },")

old = "id: n.id, label: n.label, color: n.color, size: n.size,"
assert s.count(old) == 1, ("node record", s.count(old))
s = s.replace(old, "id: n.id, label: n.label, color: n.color, size: n.size + 1.5,")

RING = """
// L21: the node border is the frame's biggest cost, and every node's border is the same
// colour as its fill, so it only makes the dot bigger by borderWidth/2. Draw that as a
// larger fill and keep a real border only for the nodes whose border IS visible: the
// hovered and the selected ones (their border is white).
(function () {
  var base = {};
  for (var id in network.body.nodes) {
    var n = network.body.nodes[id];
    if (n) base[id] = n.options.size;
  }
  function ring(id, on) {
    var n = network.body.nodes[id];
    if (!n) return;
    n.options.size = on ? base[id] - 1.5 : base[id];
    n.options.borderWidth = on ? 1.5 : 0;
  }
  network.on('hoverNode', function (p) { ring(p.node, true); });
  network.on('blurNode', function (p) { ring(p.node, false); });
  network.on('selectNode', function (p) { p.nodes.forEach(function (id) { ring(id, true); }); });
  network.on('deselectNode', function (p) { p.nodes.forEach(function (id) { ring(id, false); }); });
})();
"""

anchor = "network.on('afterDrawing', function () { _EDGE_BATCH.frame(); });"
assert s.count(anchor) == 1, ("afterDrawing anchor", s.count(anchor))
s = s.replace(anchor, RING + anchor)

io.open(DST, "w", encoding="utf-8", newline="").write(s)
print("wrote", DST, os.path.getsize(DST), "bytes")
