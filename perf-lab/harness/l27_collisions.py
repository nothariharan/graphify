"""Do two communities that share an edge still get the same colour?

  python harness/l27_collisions.py <dump.json> [<dump.json> ...]
"""
import json
import sys

for path in sys.argv[1:]:
    d = json.load(open(path, encoding="utf-8"))
    nodes = d.get("nodes") or d.get("positions") or []
    edges = d.get("edges") or []
    comm = {}
    colour = {}
    for n in nodes:
        if isinstance(n, dict):
            cid = n.get("community")
            c = n.get("color") or n.get("colour")
            if isinstance(c, dict):
                c = c.get("background")
            comm[n.get("id")] = cid
            if c:
                colour[cid] = c
    adj = {}
    for e in edges:
        if isinstance(e, dict):
            a, b = e.get("from"), e.get("to")
        else:
            a, b = e[0], e[1]
        ca, cb = comm.get(a), comm.get(b)
        if ca is None or cb is None or ca == cb:
            continue
        k = (min(ca, cb), max(ca, cb))
        adj[k] = adj.get(k, 0) + 1
    coll = [p for p in adj if colour.get(p[0]) == colour.get(p[1])]
    weight = sum(adj.values())
    wcoll = sum(adj[p] for p in coll)
    print("%-34s %d communities, %d adjacent pairs, %d colliding (%.2f%%), edge weight colliding %.2f%%"
          % (path.split("/")[-1], len(set(colour)), len(adj), len(coll),
             100.0 * len(coll) / max(1, len(adj)), 100.0 * wcoll / max(1, weight)))
