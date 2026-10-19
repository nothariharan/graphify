"""Inject the shipped lean-gesture lever into a baseline render, so the lever can be
A/B'd on graphs whose source graph.json no longer exists.

The lever is purely additive JS plus one interaction option, so text injection yields
the same artifact the exporter emits. Uses the exporter's real `_LEAN_GESTURE_JS` text.

  python harness/inject_lean.py
"""
import io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
REPO = os.path.dirname(LAB)
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from graphify.exporters.html import _LEAN_GESTURE_JS  # noqa: E402

PAIRS = [
    ("base-gsoc-agg.html", "gsoc-agg-lean.html"),
    ("base-continuum.html", "continuum-lean.html"),
    ("base-rsl.html", "rsl-lean-only.html"),
]

for src_name, dst_name in PAIRS:
    src = os.path.join(LAB, "variants", src_name)
    dst = os.path.join(LAB, "variants", dst_name)
    s = io.open(src, encoding="utf-8").read()
    hits = []

    opt = "hideEdgesOnDrag: true,"
    if opt in s and "hideEdgesOnZoom" not in s:
        s = s.replace(opt, opt + "\n    hideEdgesOnZoom: true,", 1)
        hits.append("hideEdgesOnZoom")

    anchor = "network.once('stabilizationIterationsDone'"
    if anchor in s and "_setLean" not in s:
        s = s.replace(anchor, _LEAN_GESTURE_JS + "\n" + anchor, 1)
        hits.append("lean_gesture")

    io.open(dst, "w", encoding="utf-8", newline="").write(s)
    print(f"{src_name:<26} -> {dst_name:<24} injected={hits}")
