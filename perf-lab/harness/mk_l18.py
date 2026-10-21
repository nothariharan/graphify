"""Build L18 scratch variants: a community-aware initial seed.

Fewer solver iterations alone destroys the layout (crossings 77k -> 394k at 60 iterations,
community separation 7.2 -> 1.9). The hypothesis under test here is different: give the
solver a *good* starting point - communities already placed apart, their members around
their community centre - so it needs fewer iterations to reach the same structure.

  python harness/mk_l18.py --name seed200
  python harness/mk_l18.py --name seed60 --iters 60
  python harness/mk_l18.py --name seed40 --iters 40
"""
import argparse
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v10.html")

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--iters", type=int, default=None)
ap.add_argument("--src", default=SRC)
a = ap.parse_args()

s = io.open(a.src, encoding="utf-8").read()

SEED = """
// Community-aware seed (L18): place each community apart from the others and its
// members around its centre, so the solver starts from structure instead of a spiral.
const __SEED = (function () {
  var byC = new Map();
  for (var i = 0; i < RAW_NODES.length; i++) {
    var c = RAW_NODES[i].community;
    if (!byC.has(c)) byC.set(c, []);
    byC.get(c).push(i);
  }
  var cs = Array.from(byC.keys());
  var pos = new Array(RAW_NODES.length);
  var R = 260 * Math.sqrt(cs.length);
  var GA = 2.399963229728653;
  for (var ci = 0; ci < cs.length; ci++) {
    var idxs = byC.get(cs[ci]);
    var ang = ci * GA;
    var rad = R * Math.sqrt((ci + 0.5) / cs.length);
    var cx = rad * Math.cos(ang), cy = rad * Math.sin(ang);
    var spread = 26 * Math.sqrt(idxs.length);
    for (var j = 0; j < idxs.length; j++) {
      var a2 = j * GA, r2 = spread * Math.sqrt((j + 0.5) / idxs.length);
      pos[idxs[j]] = { x: cx + r2 * Math.cos(a2), y: cy + r2 * Math.sin(a2) };
    }
  }
  return pos;
})();
"""

anchor = "const nodesDS = new vis.DataSet("
assert s.count(anchor) == 1, ("anchor", s.count(anchor))
s = s.replace(anchor, SEED + "\n" + anchor)

old_xy = """  x: (n.x !== undefined && n.x !== null) ? n.x : 30 * Math.sqrt(i) * Math.cos(i * 2.4),
  y: (n.y !== undefined && n.y !== null) ? n.y : 30 * Math.sqrt(i) * Math.sin(i * 2.4),"""
new_xy = """  x: (n.x !== undefined && n.x !== null) ? n.x : __SEED[i].x,
  y: (n.y !== undefined && n.y !== null) ? n.y : __SEED[i].y,"""
assert s.count(old_xy) == 1, ("xy", s.count(old_xy))
s = s.replace(old_xy, new_xy)

if a.iters is not None:
    old = "stabilization: { iterations: 200, fit: true },"
    assert s.count(old) == 1, ("iterations", s.count(old))
    s = s.replace(old, "stabilization: { iterations: %d, fit: true }," % a.iters)

out = os.path.join(LAB, "variants", "L18-%s.html" % a.name)
io.open(out, "w", encoding="utf-8", newline="").write(s)
print("wrote", out, os.path.getsize(out), "bytes")
