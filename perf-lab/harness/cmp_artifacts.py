"""Compare two exported graph.html artifacts semantically.

The exporter's output is not byte-stable (Python's hash randomisation can reorder
same-valued dict/set-derived structures), so compare the payloads rather than hashes.

  python harness/cmp_artifacts.py a.html b.html [more.html ...]
"""
import hashlib
import io
import json
import sys


def payload(path: str):
    s = io.open(path, encoding="utf-8").read()
    out = {}
    for name in ("RAW_NODES", "RAW_EDGES"):
        marker = f"const {name} = "
        i = s.index(marker) + len(marker)
        j = s.index("\n", i)
        out[name] = json.loads(s[i:j].rstrip().rstrip(";"))
    out["sha16"] = hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]
    return out


files = sys.argv[1:]
base = payload(files[0])
print(f"reference: {files[0]}")
print(f"  nodes={len(base['RAW_NODES'])} edges={len(base['RAW_EDGES'])} sha={base['sha16']}")
for f in files[1:]:
    p = payload(f)
    n_eq = p["RAW_NODES"] == base["RAW_NODES"]
    e_eq = p["RAW_EDGES"] == base["RAW_EDGES"]
    n_set = {n["id"] for n in p["RAW_NODES"]} == {n["id"] for n in base["RAW_NODES"]}
    e_set = {(e["from"], e["to"], e.get("label"), e.get("confidence")) for e in p["RAW_EDGES"]} == \
            {(e["from"], e["to"], e.get("label"), e.get("confidence")) for e in base["RAW_EDGES"]}
    print(f"{f}")
    print(f"  nodes={len(p['RAW_NODES'])} edges={len(p['RAW_EDGES'])} sha={p['sha16']}")
    print(f"  node list identical (incl. order): {n_eq}   node id set: {n_set}")
    print(f"  edge list identical (incl. order): {e_eq}   edge set: {e_set}")
