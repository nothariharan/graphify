"""Build L20 scratch variants: is the node *border* the expensive part of the node pass?

The probe says the frame is ~82 ms, only ~17 ms of that is inside vis's per-node JS, and
replaying the same 1886 dots on the same canvas costs ~2 ms. The rest is rasterization, and
a hairline stroke (borderWidth 1.5 world units, ~0.12 px on screen at the fit scale) is the
kind of thing a software rasterizer is bad at.

The exporter paints every node's border in the *same* colour as its fill, so the border
only makes the dot bigger by borderWidth/2. Emitting `borderWidth: 0` and
`size: size + 1.5` draws the identical disc with one fill instead of a fill plus a
hairline stroke.

  python harness/mk_l20.py --name noborder --border 0
  python harness/mk_l20.py --name noborder-swap --border 0 --swap
"""
import argparse
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v10.html")

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--border", type=float, default=0.0)
ap.add_argument("--swap", action="store_true", help="also grow the size by the border width")
ap.add_argument("--src", default=SRC)
a = ap.parse_args()

s = io.open(a.src, encoding="utf-8").read()

old = "nodes: { shape: 'dot', borderWidth: 1.5 },"
assert s.count(old) == 1, ("nodes options", s.count(old))
s = s.replace(old, "nodes: { shape: 'dot', borderWidth: %s }," % a.border)

if a.swap:
    # the node record: size is emitted as `size: <n>,` per node
    old2 = "size: round(size, 1),"
    n = s.count(old2)
    assert n > 0, "size field"
    s = s.replace(old2, "size: round(size + 1.5, 1),")
    print("swapped size on", n, "nodes")

out = os.path.join(LAB, "variants", "L20-%s.html" % a.name)
io.open(out, "w", encoding="utf-8", newline="").write(s)
print("wrote", out, os.path.getsize(out), "bytes")
