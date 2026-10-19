"""Aggregate the canonical measurements CSV: min/max per (lane, graph, dpr, variant).

  python harness/agg.py [lane] [graph] [dpr]
"""
import csv, sys, collections, io

path = 'results/measurements.csv'
flt = sys.argv[1:]
rows = list(csv.DictReader(io.open(path, encoding='utf-8')))
def keep(r):
    vals = [r['lane'], r['graph'], str(r['dpr'])]
    for i, f in enumerate(flt):
        if i < 3 and f and f.lower() not in vals[i].lower():
            return False
    return True
sel = [r for r in rows if keep(r)]
def fnum(x, k):
    try: return float(x[k])
    except Exception: return None
def mn(rs, k):
    v = [fnum(x, k) for x in rs]; v = [y for y in v if y is not None]
    return min(v) if v else float('nan')
def mx(rs, k):
    v = [fnum(x, k) for x in rs]; v = [y for y in v if y is not None]
    return max(v) if v else float('nan')
g = collections.defaultdict(list)
for r in sel: g[(r['lane'], r['graph'], r['dpr'], r['variant'])].append(r)
print(f"{'lane':5} {'graph':10} {'dpr':4} {'variant':16} {'n':>2} {'rwmin':>7} {'rwmed':>7} {'load':>7} {'pan':>6} {'zoom':>6} {'hover':>6} {'ltot':>7} {'heap':>6}")
for (lane, graph, dpr, var), rs in sorted(g.items()):
    print(f"{lane:5} {graph:10} {dpr:4} {var:16} {len(rs):2} "
          f"{mn(rs,'redraw_min'):7.1f} {mn(rs,'redraw_med'):7.1f} {mn(rs,'load_ms'):7.0f} "
          f"{mx(rs,'pan_fps'):6.1f} {mx(rs,'zoom_fps'):6.1f} {mx(rs,'hover_fps'):6.1f} "
          f"{mn(rs,'longtask_total'):7.0f} {mx(rs,'heap_mb'):6.1f}")
