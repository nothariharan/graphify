"""Build first-open load variants from the v8 artifact.

  v8-it200.html   baseline (solver 200 iterations)
  v8-it60.html    solver capped at 60 iterations
  v8-it30.html    solver capped at 30 iterations
  v8-nolayout.html  200 iterations, improvedLayout:false
  v8-baked.html   produced separately by harness/bake.mjs (physics off + x/y)

  python harness/mk_load_variants.py
"""
import io
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "v8-obsidian.html")

s = io.open(SRC, encoding="utf-8", newline="").read()
if "stabilization:" not in s:
    raise SystemExit("no stabilization block")


def write(name, fn):
    out = fn(s)
    if out == s:
        raise SystemExit("no change for " + name)
    p = os.path.join(LAB, "variants", name)
    io.open(p, "w", encoding="utf-8", newline="").write(out)
    print("wrote", name, len(out))


def iters(n):
    def f(src):
        return re.sub(r"iterations: \d+", "iterations: %d" % n, src, count=1)
    return f


write("v8-it60.html", iters(60))
write("v8-it30.html", iters(30))
write("v8-it0.html", iters(0))


def nolayout(src):
    return src.replace("physics: {", "physics: {\n    improvedLayout: false,", 1)


write("v8-nolayout.html", nolayout)
