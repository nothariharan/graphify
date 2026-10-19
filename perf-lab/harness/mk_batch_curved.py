"""Straight vs curve-faithful batched edge pass, derived from the shipped artifact.

The batch draws `moveTo(from); _curveTo(...)` per edge. `_curveTo` reproduces the exact
quadratic vis draws at rest for `smooth: {type: 'continuous'}` (the via point is a
closed-form offset from `from`, clamped into the segment's box - see _getViaCoordinates in
BezierEdgeDynamic). Drawing straight lines instead is faster, but a frame-by-frame pixel
diff against the resting frame showed 82-100% of painted pixels changing with straight
lines versus 1.1-1.8% with the curve, so the shipped batch draws the curve.

This script builds the "what if straight" variant for the A/B record, plus "noborder"
copies where the node border lean is a no-op (BORDER_LEAN = 1.5) so that a mid-gesture
frame and a resting frame differ ONLY by the edge batch - that is what
probe_motion_pixels.mjs needs to measure edge fidelity.

  python harness/mk_batch_curved.py
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v7.html")

CURVE_CALL = "        _curveTo(g, et);"
STRAIGHT_CALL = "        g.lineTo(et.toPoint.x, et.toPoint.y);"
BORDER_ANCHOR = "const _BORDER_FULL = 1.5, _BORDER_LEAN = 0;"
BORDER_NOOP = "const _BORDER_FULL = 1.5, _BORDER_LEAN = 1.5;  // noborder build: lean is a no-op"


def write(name, text, label):
    out = os.path.join(LAB, "variants", name)
    io.open(out, "w", encoding="utf-8", newline="").write(text)
    print(f"{name:<34} {label}")


s = io.open(SRC, encoding="utf-8", newline="").read()
# The artifact is CRLF; the patterns above are written with LF. Match in the file's own
# line ending so a replacement never silently no-ops (or rewrites the whole file).
EOL = "\r\n" if "\r\n" in s[:4000] else "\n"


def pat(text):
    return text.replace("\n", EOL)


if pat(CURVE_CALL) not in s:
    raise SystemExit("!! curve call not found in " + os.path.basename(SRC))
if pat(BORDER_ANCHOR) not in s:
    raise SystemExit("!! border anchor not found")

straight = s.replace(pat(CURVE_CALL), pat(STRAIGHT_CALL), 1)
write("batch-straight.html", straight, "straight batch (A/B reference, v7 otherwise)")

write("batch-straight-noborder.html", straight.replace(pat(BORDER_ANCHOR), pat(BORDER_NOOP), 1),
      "straight batch, border lean no-op (pixel fidelity test)")
write("batch-curved-noborder.html", s.replace(pat(BORDER_ANCHOR), pat(BORDER_NOOP), 1),
      "curved batch, border lean no-op (pixel fidelity test)")
