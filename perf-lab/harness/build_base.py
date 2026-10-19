#!/usr/bin/env python
"""Build a base graph.html from a graphify graph.json using the real exporter.

Usage:
  python build_base.py --graph-json <path> --name continuum [--node-limit 1000000000]

Writes variants/base-<name>.html with node_limit forced high so the FULL graph is
rendered (no community aggregation). Prints the actual node/edge counts.
"""
import argparse, io, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
REPO = os.path.dirname(LAB)
if REPO not in sys.path:
    sys.path.insert(0, REPO)

import networkx as nx  # noqa: E402
from graphify.exporters.html import to_html  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--graph-json", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--node-limit", type=int, default=10 ** 9)
    a = ap.parse_args()

    d = json.load(io.open(a.graph_json, encoding="utf-8"))
    G = nx.Graph()
    communities = {}
    for n in d.get("nodes", []):
        attrs = {k: v for k, v in n.items() if k != "id"}
        G.add_node(n["id"], **attrs)
        communities.setdefault(int(n.get("community", 0)), []).append(n["id"])
    links = d.get("links") or d.get("edges") or []
    for e in links:
        s, t = e.get("source"), e.get("target")
        if s is None or t is None:
            continue
        attrs = {k: v for k, v in e.items() if k not in ("source", "target")}
        G.add_edge(s, t, **attrs)

    out = os.path.join(LAB, "variants", f"base-{a.name}.html")
    ok = to_html(G, communities, out, node_limit=a.node_limit)
    if not os.path.exists(out):
        raise SystemExit(f"to_html wrote nothing (returned {ok})")
    s = io.open(out, encoding="utf-8", errors="replace").read()
    m = re.search(r"const RAW_NODES\s*=\s*(\[.*?\]);", s, re.S)
    m2 = re.search(r"const RAW_EDGES\s*=\s*(\[.*?\]);", s, re.S)
    n_nodes = m.group(1).count('"id"') if m else -1
    n_edges = m2.group(1).count('"from"') if m2 else -1
    print(f"wrote {out}  {os.path.getsize(out)//1024} KB  nodes={n_nodes} edges={n_edges} communities={len(communities)}")


if __name__ == "__main__":
    main()
