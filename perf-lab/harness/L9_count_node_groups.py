"""L9: count the distinct (fill colour, radius/size) pairs in the exported artifact.

Hypothesis 1 only pays if the number of distinct pairs is small against the node count.
The vis node arc radius for shape 'dot' is the node `size` option (see _drawRawCircle ->
UA(g, x, y, values.size) in vis-network.min.js), and the fill colour is values.color.

  python harness/L9_count_node_groups.py [file]
"""
import collections
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(LAB, "variants", "base-ours-v7.html")

s = io.open(SRC, encoding="utf-8", errors="replace").read()
m = re.search(r"const RAW_NODES = (\[.*?\]);\r?\n", s, re.S)
if not m:
    raise SystemExit("!! RAW_NODES not found")
nodes = json.loads(m.group(1))
print(f"{os.path.basename(SRC)}")
print(f"nodes: {len(nodes)}")
print(f"keys: {sorted(nodes[0].keys())}")


def bg(n):
    c = n.get("color")
    return c.get("background") if isinstance(c, dict) else c


def border(n):
    c = n.get("color")
    return c.get("border") if isinstance(c, dict) else None


pairs = collections.Counter((bg(n), n.get("size")) for n in nodes)
print(f"distinct (color.background, size) pairs: {len(pairs)}")
for k, v in pairs.most_common(12):
    print(f"    {k}  x{v}")
sizes = collections.Counter(n.get("size") for n in nodes)
print(f"distinct sizes: {len(sizes)}  -> {sizes.most_common(12)}")
cols = collections.Counter(bg(n) for n in nodes)
print(f"distinct colors: {len(cols)}  -> {cols.most_common(6)}")
borders = collections.Counter(border(n) for n in nodes)
print(f"distinct border colors: {len(borders)}  -> {borders.most_common(6)}")
fnt = collections.Counter(json.dumps(n.get("font"), sort_keys=True) for n in nodes)
print(f"distinct fonts: {len(fnt)}")
print(f"nodes with a label: {sum(1 for n in nodes if n.get('label'))}")
print(f"sample node: {json.dumps(nodes[0])[:400]}")
# what does a group actually save? nodes per pair
counts = sorted(pairs.values(), reverse=True)
print(f"groups>=2 nodes: {sum(1 for c in counts if c >= 2)}")
print(f"largest group: {counts[0]}, median group: {counts[len(counts)//2]}")
