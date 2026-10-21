"""Make a build static: physics off, so the picture is the seed layout and two builds can
be compared pixel by pixel.

  python harness/mk_static.py --src variants/base-ours-v10.html --out variants/S-v10.html
"""
import argparse
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--out", required=True)
a = ap.parse_args()

s = io.open(os.path.join(LAB, a.src), encoding="utf-8").read()

old = """  physics: {
    enabled: true,"""
assert s.count(old) == 1, ("physics block", s.count(old))
s = s.replace(old, """  physics: {
    enabled: false,""")

out = os.path.join(LAB, a.out)
io.open(out, "w", encoding="utf-8", newline="").write(s)
print("wrote", out, os.path.getsize(out), "bytes")
