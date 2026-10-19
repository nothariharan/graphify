"""Characterise edge differences between two exported artifacts.

The exporter restores edge direction from stashed _src/_tgt; when those are absent,
NetworkX canonicalises endpoint order and the rendered arrow can flip. This reports
whether differing edges are direction flips or genuinely different edges.

  python harness/edge_diff.py a.html b.html
"""
import io
import json
import sys
from collections import Counter


def edges(path):
    s = io.open(path, encoding="utf-8").read()
    marker = "const RAW_EDGES = "
    i = s.index(marker) + len(marker)
    j = s.index("\n", i)
    return json.loads(s[i:j].rstrip().rstrip(";"))


a, b = (edges(p) for p in sys.argv[1:3])
ka = [(e["from"], e["to"]) for e in a]
kb = [(e["from"], e["to"]) for e in b]
sa, sb = set(ka), set(kb)

print(f"A={sys.argv[1]}  B={sys.argv[2]}")
print(f"edges: {len(ka)} vs {len(kb)}")
print(f"identical as ordered pairs: {ka == kb}")
print(f"order-only difference:      {sorted(ka) == sorted(kb) and ka != kb}")
only_a, only_b = sa - sb, sb - sa
print(f"pairs only in A: {len(only_a)}   pairs only in B: {len(only_b)}")
flips = [p for p in only_a if (p[1], p[0]) in sb]
print(f"of A-only, reversed pair present in B (=> direction flip): {len(flips)}")
print("\nsample differing pairs (A -> reversed form):")
for p in flips[:6]:
    print(f"  A {p[0]} -> {p[1]}    B {p[1]} -> {p[0]}")
others = [p for p in only_a if (p[1], p[0]) not in sb]
print(f"\nA-only pairs with no reverse in B (=> different edge, not a flip): {len(others)}")
for p in others[:6]:
    print(f"  A {p[0]} -> {p[1]}")
lab_a = Counter((e["from"], e["to"], e.get("label")) for e in a)
lab_b = Counter((e["from"], e["to"], e.get("label")) for e in b)
print(f"\nedge labels identical as unordered multiset: "
      f"{Counter((tuple(sorted(p[:2])) + (p[2],)) for p in lab_a.elements()) == Counter((tuple(sorted(p[:2])) + (p[2],)) for p in lab_b.elements())}")
