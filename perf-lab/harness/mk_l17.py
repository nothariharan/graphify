"""Build L17 scratch variants: how much of the 9.9 s first open is the solver, and what
does the layout look like with fewer iterations / without vis's improvedLayout?

  python harness/mk_l17.py --name it60 --iters 60
  python harness/mk_l17.py --name nil --no-il
  python harness/mk_l17.py --name it60nil --iters 60 --no-il

Source is the shipped artifact, so the only difference is the physics block.
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
ap.add_argument("--no-il", action="store_true", help="improvedLayout: false")
ap.add_argument("--src", default=SRC)
a = ap.parse_args()

s = io.open(a.src, encoding="utf-8").read()

if a.iters is not None:
    old = "stabilization: { iterations: 200, fit: true },"
    assert s.count(old) == 1, ("iterations block", s.count(old))
    s = s.replace(old, "stabilization: { iterations: %d, fit: true }," % a.iters)

if a.no_il:
    old = """  physics: {
    enabled: true,"""
    assert s.count(old) == 1, ("physics block", s.count(old))
    s = s.replace(old, """  physics: {
    improvedLayout: false,
    enabled: true,""")

out = os.path.join(LAB, "variants", "L17-%s.html" % a.name)
io.open(out, "w", encoding="utf-8", newline="").write(s)
print("wrote", out, os.path.getsize(out), "bytes")
