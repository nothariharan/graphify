"""Generate extra drag-test variants from our fixed build by text substitution.

  python harness/mk_drag_variants.py
"""
import io, os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-fixed.html")
s = io.open(SRC, encoding="utf-8").read()

NOBORDER = ("nodes: { shape: 'dot', borderWidth: 1.5 }",
            "nodes: { shape: 'dot', borderWidth: 0 }")
HIDEZOOM = ("hideEdgesOnDrag: true,",
            "hideEdgesOnDrag: true,\n    hideEdgesOnZoom: true,")

COMBOS = {
    "ours-noborder.html": [NOBORDER],
    "ours-hidezoom.html": [HIDEZOOM],
    "ours-noborder-hidezoom.html": [NOBORDER, HIDEZOOM],
}

for name, pairs in COMBOS.items():
    out = s
    hits = []
    for a, b in pairs:
        if a in out:
            out = out.replace(a, b)
            hits.append(True)
        else:
            hits.append(False)
    dst = os.path.join(LAB, "variants", name)
    io.open(dst, "w", encoding="utf-8", newline="").write(out)
    print(f"wrote {name}  substitutions={sum(hits)}/{len(pairs)}  ({os.path.getsize(dst)//1024} KB)")
