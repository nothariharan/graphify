"""Build the L16 scratch variant: the edge batch grouped by *runs* of consecutive
same-colour edges instead of by colour class.

Colour grouping reorders the strokes, so where two translucent edges cross a different
one ends up on top (10.22% of painted pixels differ in colour, coverage identical).
Grouping consecutive runs keeps vis's own edge order, at the cost of more strokes
(303 runs vs 10 colour classes on rsl).

  python harness/mk_l16.py            -> variants/L16-run-batch.html
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
SRC = os.path.join(LAB, "variants", "base-ours-v10.html")
DST = os.path.join(LAB, "variants", "L16-run-batch.html")

s = io.open(SRC, encoding="utf-8").read()

old_decl = "const map = new Map();"
new_decl = "const map = new Map(); let lastGrp = null; const runGroups = [];"
assert s.count(old_decl) == 1, s.count(old_decl)
s = s.replace(old_decl, new_decl)

old_group = """      const key = col + '|' + baseW;
      let grp = map.get(key);
      if (!grp) map.set(key, grp = { col: col, baseW: baseW, ets: [] });
      grp.ets.push(e.edgeType);
    }
    _groups = [];
    for (const grp of map.values()) _groups.push(grp);"""
new_group = """      const key = col + '|' + baseW;
      if (!lastGrp || lastGrp.key !== key) {
        lastGrp = { key: key, col: col, baseW: baseW, ets: [] };
        runGroups.push(lastGrp);
      }
      lastGrp.ets.push(e.edgeType);
    }
    _groups = runGroups;"""
assert s.count(old_group) == 1, s.count(old_group)
s = s.replace(old_group, new_group)

io.open(DST, "w", encoding="utf-8", newline="").write(s)
print("wrote", DST, os.path.getsize(DST), "bytes")
