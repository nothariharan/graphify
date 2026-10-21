"""Temporarily put the dashed edges back into the batch (L23 experiment).

The batch hands the 393 dashed (INFERRED confidence) edges back to vis so their dash
rendering is exactly vis's own. That costs 393 extra strokes per frame. This script
reverses that in the exporter so a scratch artifact can be built and measured; run
`git checkout -- graphify/exporters/html.py` afterwards.

  python harness/mk_l23.py apply   -> patches the exporter
  python harness/mk_l23.py revert  -> undoes the patch
"""
import io
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PATH = os.path.join(REPO, "graphify", "exporters", "html.py")

OLD_GROUP = """      if (_dashOf(t)) { e.edgeType.__leanDash = true; continue; }
      if (e.edgeType.__leanDash) delete e.edgeType.__leanDash;
      const baseW = (e.options && typeof e.options.width === 'number') ? e.options.width : t.width;
      const key = col + '|' + baseW;
      let grp = map.get(key);
      if (!grp) map.set(key, grp = { col: col, baseW: baseW, ets: [] });
      grp.ets.push(e.edgeType);"""
NEW_GROUP = """      const dash = _dashOf(t);
      const baseW = (e.options && typeof e.options.width === 'number') ? e.options.width : t.width;
      const key = col + '|' + (dash ? dash.join(',') : '') + '|' + baseW;
      let grp = map.get(key);
      if (!grp) map.set(key, grp = { col: col, baseW: baseW, dash: dash, ets: [] });
      grp.ets.push(e.edgeType);"""

OLD_DRAW = """      g.lineWidth = Math.max(grp.baseW, floor);
      g.beginPath();"""
NEW_DRAW = """      g.lineWidth = Math.max(grp.baseW, floor);
      if (grp.dash) { g.save(); g.lineCap = 'round'; g.setLineDash(grp.dash); }
      g.beginPath();"""

OLD_DRAW_END = """        _curveTo(g, et);
      }
      g.stroke();
    }
  }"""
NEW_DRAW_END = """        _curveTo(g, et);
      }
      g.stroke();
      if (grp.dash) g.restore();
    }
  }"""

OLD_FALL = "if (sel || hov || this.__leanDash || _arrowed(this)) {"
NEW_FALL = "if (sel || hov || _arrowed(this)) {"

s = io.open(PATH, encoding="utf-8").read()

if sys.argv[1] == "revert":
    s = s.replace(NEW_GROUP, OLD_GROUP).replace(NEW_DRAW, OLD_DRAW)
    s = s.replace(NEW_DRAW_END, OLD_DRAW_END).replace(NEW_FALL, OLD_FALL)
else:
    for old in (OLD_GROUP, OLD_DRAW, OLD_DRAW_END, OLD_FALL):
        assert s.count(old) == 1, ("marker", old[:40], s.count(old))
        s = s.replace(old, {"OLD_GROUP": NEW_GROUP, "OLD_DRAW": NEW_DRAW,
                            "OLD_DRAW_END": NEW_DRAW_END, "OLD_FALL": NEW_FALL}[old[:9]] if False else old)
    s = s.replace(OLD_GROUP, NEW_GROUP).replace(OLD_DRAW, NEW_DRAW)
    s = s.replace(OLD_DRAW_END, NEW_DRAW_END).replace(OLD_FALL, NEW_FALL)

io.open(PATH, "w", encoding="utf-8", newline="").write(s)
print(sys.argv[1], "ok")
