"""Report the first differing entries between two artifacts' node/edge payloads.

  python harness/payload_diff.py a.html b.html [count]
"""
import io
import json
import sys


def payload(path):
    s = io.open(path, encoding="utf-8").read()
    out = {}
    for name in ("RAW_NODES", "RAW_EDGES"):
        m = f"const {name} = "
        i = s.index(m) + len(m)
        j = s.index("\n", i)
        out[name] = json.loads(s[i:j].rstrip().rstrip(";"))
    return out


n = int(sys.argv[3]) if len(sys.argv) > 3 else 3
a, b = (payload(p) for p in sys.argv[1:3])
for key in ("RAW_NODES", "RAW_EDGES"):
    la, lb = a[key], b[key]
    if la == lb:
        print(f"{key}: identical ({len(la)} entries)")
        continue
    diffs = [(x, y) for x, y in zip(la, lb) if x != y]
    print(f"{key}: {len(la)} vs {len(lb)} entries, {len(diffs)} differing positionally")
    if not diffs:
        print("  (same positional entries but not equal as a whole: length or ordering)")
        continue
    for x, y in diffs[:n]:
        keys = sorted({k for k in set(x) | set(y) if x.get(k) != y.get(k)})
        print(f"  differing keys: {keys}")
        for k in keys:
            print(f"    {k}: {x.get(k)!r}  |  {y.get(k)!r}")
