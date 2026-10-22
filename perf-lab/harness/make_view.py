"""Build a side-by-side view of the CURRENT shipped render vs OUR render.

  python harness/make_view.py

Writes perf-lab/view/before.html (shipped defaults) and perf-lab/view/after.html
(our renderer), both with vis-network localized so they work without the CDN.
"""
import io, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
VIEW = os.path.join(LAB, "view")
os.makedirs(VIEW, exist_ok=True)

CDN_RE = re.compile(r'<script src="https://unpkg\.com/vis-network[^>]*?(?:/>|></script>)', re.S)
# Relative so the page works both over http (served from perf-lab) and when the
# file is opened directly with file://.
LOCAL = '<script src="../data/vis-network.min.js"></script>'


def localize(src, dst, label):
    s = io.open(src, encoding="utf-8").read()
    s2, n = CDN_RE.subn(LOCAL, s, count=1)
    io.open(dst, "w", encoding="utf-8", newline="").write(s2)
    print(f"{label:<22} {os.path.basename(src):<28} -> {os.path.basename(dst):<12} "
          f"cdn_replaced={n}  arrows_eager={'enabled: true, scaleFactor: 0.5' in s}  "
          f"arrows_deferred={'arrows: { to: { enabled: false } },' in s}  cache={'_savePositions' in s}")


localize(os.path.join(LAB, "variants", "base-official-v8.html"),
         os.path.join(VIEW, "before.html"), "OFFICIAL graphify (safishamsi/graphify v8 @ 847a93f3)")
localize(os.path.join(LAB, "variants", "base-maincheckout.html"),
         os.path.join(VIEW, "before-your-checkout.html"), "your checkout (3a09ba73)")
localize(os.path.join(LAB, "variants", "base-ours-v19.html"),
         os.path.join(VIEW, "after.html"), "OURS (v19: + stable node size while zooming, click focus fixed)")
print("wrote", VIEW)
