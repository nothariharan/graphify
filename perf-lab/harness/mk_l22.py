"""L22: the same visible node, without the border stroke.

v10 draws each node as a fill of radius size/2 plus a border stroke of width
min(size, 1.5/scale) centred on the path - at the fit scale that border is as wide as the
node itself, so the visible disc is twice the fill radius and the fill is invisible under
it. The border colour is the fill colour, so the picture is "a disc of that colour".

L21 (borderWidth 0) therefore made the nodes *smaller* on screen: it was part win, part
visual change. L22 keeps the picture and removes only the stroke: borderWidth 0 and the
size grown so the disc has the same radius.

  python harness/mk_l22.py
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v10.html")
DST = os.path.join(LAB, "variants", "L22-same-disc.html")

s = io.open(SRC, encoding="utf-8").read()

old = "nodes: { shape: 'dot', borderWidth: 1.5 },"
assert s.count(old) == 1, ("nodes options", s.count(old))
s = s.replace(old, "nodes: { shape: 'dot', borderWidth: 0 },")

old = "id: n.id, label: n.label, color: n.color, size: n.size,"
assert s.count(old) == 1, ("node record", s.count(old))
# the visible disc is size/2 + min(size, 1.5/scale)/2; at the fit scale the min() is the
# node's own width, so the visible radius is the full size -> grow the fill to 2 * size
s = s.replace(old, "id: n.id, label: n.label, color: n.color, size: n.size * 2,")

RING = """
// L22: the node disc is drawn with one fill instead of a fill plus a border stroke of the
// same colour, so the picture is the same and the stroke is gone. The hovered and the
// selected node keep a real border, because theirs is white and therefore visible.
(function () {
  var base = {};
  for (var id in network.body.nodes) {
    var n = network.body.nodes[id];
    if (n) base[id] = n.options.size;
  }
  function ring(id, on) {
    var n = network.body.nodes[id];
    if (!n) return;
    n.options.size = on ? base[id] / 2 : base[id];
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
