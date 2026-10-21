"""Build L19 scratch variants: is the 6.3 s solver time the force math, or vis's
per-iteration node-overlap pass?

`avoidOverlap` in vis is an O(n^2) check over all node pairs, and it runs on every solver
iteration. On rsl (1886 nodes) that is 3.5 M distance checks per iteration, 200 times -
which is the right suspect for 31 ms per iteration.

  python harness/mk_l19.py --name av0 --avoid 0
  python harness/mk_l19.py --name av03 --avoid 0.3
"""
import argparse
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v10.html")

ap = argparse.ArgumentParser()
ap.add_argument("--name", required=True)
ap.add_argument("--avoid", type=float, default=None)
ap.add_argument("--iters", type=int, default=None)
ap.add_argument("--src", default=SRC)
a = ap.parse_args()

s = io.open(a.src, encoding="utf-8").read()

if a.avoid is not None:
    old = "avoidOverlap: 0.8,"
    assert s.count(old) == 1, ("avoidOverlap", s.count(old))
    s = s.replace(old, "avoidOverlap: %s," % a.avoid)

if a.iters is not None:
    old = "stabilization: { iterations: 200, fit: true },"
    assert s.count(old) == 1, ("iterations", s.count(old))
    s = s.replace(old, "stabilization: { iterations: %d, fit: true }," % a.iters)

out = os.path.join(LAB, "variants", "L19-%s.html" % a.name)
io.open(out, "w", encoding="utf-8", newline="").write(s)
print("wrote", out, os.path.getsize(out), "bytes")
