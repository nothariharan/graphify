"""Variant of the lean lever that avoids the setOptions redraw spike.

`network.setOptions({nodes:{borderWidth}})` re-applies options to every node and costs
about one full synchronous redraw (measured: rsl ~80ms, gsoc-agg ~200ms, continuum
~670-2000ms), so it hitchs once at dragStart and once at dragEnd.

This writes the border width onto the node instances instead: vis reads
node.options.borderWidth every frame, so the next (drag) frame picks it up with no
recompute and no extra draw. Uses vis internals, so it is version-brittle - which is
exactly why it is measured before being shipped.

  python harness/inject_lean_direct.py
"""
import io, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
REPO = os.path.dirname(LAB)
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from graphify.exporters.html import _LEAN_GESTURE_JS  # noqa: E402

OLD = ("  try { network.setOptions({ nodes: { borderWidth: on ? _BORDER_LEAN : _BORDER_FULL } }); } catch (e) {}")
NEW = ("  try {\n"
       "    const bw = on ? _BORDER_LEAN : _BORDER_FULL;\n"
       "    const nodes = network.body && network.body.nodes;\n"
       "    if (nodes) { for (const id in nodes) { if (nodes[id] && nodes[id].options) nodes[id].options.borderWidth = bw; } }\n"
       "    else { network.setOptions({ nodes: { borderWidth: bw } }); }\n"
       "  } catch (e) {}")

PAIRS = [
    ("base-rsl.html", "rsl-lean-direct.html"),
    ("base-gsoc-agg.html", "gsoc-agg-lean-direct.html"),
    ("base-continuum.html", "continuum-lean-direct.html"),
]

for src_name, dst_name in PAIRS:
    s = io.open(os.path.join(LAB, "variants", src_name), encoding="utf-8").read()
    opt = "hideEdgesOnDrag: true,"
    s = s.replace(opt, opt + "\n    hideEdgesOnZoom: true,", 1)
    s = s.replace("network.once('stabilizationIterationsDone'", _LEAN_GESTURE_JS + "\nnetwork.once('stabilizationIterationsDone'", 1)
    if OLD not in s:
        print(f"!! {src_name}: setOptions line not found")
        continue
    s = s.replace(OLD, NEW, 1)
    io.open(os.path.join(LAB, "variants", dst_name), "w", encoding="utf-8", newline="").write(s)
    print(f"{src_name:<26} -> {dst_name:<30} direct-mutation injected")
