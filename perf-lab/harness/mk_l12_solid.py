"""Build the solid-edge control for the L12 parity probe.

The at-rest batch leaves 1.74% of painted pixels differing, and dashes are the documented
residual (setLineDash is per-path, so grouping shifts the phase). This control removes the
dashes from the *data* - every edge EXTRACTED-style solid - so the same probe becomes a test
of the geometry, colour and width the batch draws: if the diff goes to zero, the residual is
the dash phase and nothing else.

  python harness/mk_l12_solid.py
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "L12-rest-batch.html")
OUT = os.path.join(LAB, "variants", "L12-rest-batch-solid.html")

s = io.open(SRC, encoding="utf-8").read()
n = s.count('"dashes": true')
if n == 0:
    raise SystemExit("no dashed edges found in " + SRC)
s = s.replace('"dashes": true', '"dashes": false')
io.open(OUT, "w", encoding="utf-8", newline="").write(s)
print("wrote", OUT, "with", n, "edges forced solid")
