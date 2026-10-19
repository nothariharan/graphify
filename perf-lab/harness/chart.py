#!/usr/bin/env python
"""Render results/measurements.csv into a self-contained results/chart.html (no CDN).

Aggregates by (graph, dpr, variant): redraw_min = min across reps (stable signal),
load_ms = min, pan_fps = max.
"""
import csv, os, html, collections

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
CSV = os.path.join(LAB, "results", "measurements.csv")
OUT = os.path.join(LAB, "results", "chart.html")


def load():
    rows = list(csv.DictReader(open(CSV, encoding="utf-8")))
    agg = {}
    for r in rows:
        k = (r["graph"], r["dpr"], r["variant"])
        a = agg.setdefault(k, {"redraw_min": 1e9, "load_ms": 1e9, "pan_fps": 0.0,
                               "nodes": r["nodes"], "edges": r["edges"], "reps": 0})
        a["redraw_min"] = min(a["redraw_min"], float(r["redraw_min"]))
        a["load_ms"] = min(a["load_ms"], float(r["load_ms"]))
        a["pan_fps"] = max(a["pan_fps"], float(r["pan_fps"]))
        a["reps"] += 1
    return agg


def bars(items, width=760, bar_h=20, gap=6, unit="", title="", fmt="{v:g}", base_val=None, base_label=None):
    """items: [(name, value)] in display order. base_val sets the 1.0 reference width."""
    if not items:
        return ""
    ref = base_val if base_val else (items[0][1] or 1.0)
    vmax = max(max(v for _, v in items), ref) or 1.0
    h = len(items) * (bar_h + gap) + 24
    label_w = 190
    plot_w = width - label_w - 70
    out = [f'<svg width="{width}" height="{h}" role="img" aria-label="{html.escape(title)}">']
    out.append(f'<text x="0" y="14" font-size="13" font-weight="600">{html.escape(title)}</text>')
    y = 24
    for name, v in items:
        w = max(1, int(plot_w * (v / vmax)))
        col = "#c0392b" if name == base_label else "#2f6feb"
        out.append(f'<text x="0" y="{y+14}" font-size="12" font-family="monospace">{html.escape(name)}</text>')
        out.append(f'<rect x="{label_w}" y="{y}" width="{w}" height="{bar_h}" rx="3" fill="{col}"/>')
        txt = fmt.format(v=v) + unit
        out.append(f'<text x="{label_w+w+6}" y="{y+14}" font-size="12" font-family="monospace">{txt}</text>')
        y += bar_h + gap
    out.append("</svg>")
    return "\n".join(out)


def main():
    agg = load()
    graphs = sorted(set(g for g, _, _ in agg))
    sections = []
    for g in graphs:
        dprs = sorted(set(d for gg, d, _ in agg if gg == g), key=int)
        for d in dprs:
            items = sorted([(v, a) for (gg, dd, v), a in agg.items() if gg == g and dd == d],
                           key=lambda x: x[1]["redraw_min"])
            base_val = next((a["redraw_min"] for v, a in items if v == "v00-baseline"), items[0][1]["redraw_min"])
            red = [(v, a["redraw_min"] / base_val) for v, a in items]
            loadb = sorted([(v, a["load_ms"]) for v, a in items], key=lambda x: x[1])
            nodes = items[0][1]["nodes"]
            edges = items[0][1]["edges"]
            sections.append(f"<h2>{html.escape(g)} &middot; dpr={d} &middot; {nodes} nodes / {edges} edges</h2>")
            sections.append(bars(red, title="redraw vs baseline (1.00 = v00-baseline, lower is better)",
                                 fmt="{v:.2f}", base_val=1.0, base_label="v00-baseline"))
            sections.append(bars(loadb, title="load_ms (on-load parse + physics; min)",
                                 fmt="{v:.0f}", base_label="v00-baseline"))
            sections.append("<table><tr><th>variant</th><th>redraw_min ms</th><th>redraw x</th><th>load_ms</th><th>pan_fps</th><th>reps</th></tr>")
            for v, a in items:
                sections.append(f"<tr><td>{html.escape(v)}</td><td>{a['redraw_min']:.1f}</td>"
                                f"<td>{a['redraw_min']/base_val:.2f}</td>"
                                f"<td>{a['load_ms']:.0f}</td><td>{a['pan_fps']:.1f}</td><td>{a['reps']}</td></tr>")
            sections.append("</table>")

    doc = f"""<!doctype html><html><head><meta charset="utf-8"><title>graphify perf-lab</title>
<style>
body{{font:14px/1.5 system-ui,Segoe UI,sans-serif;margin:24px;color:#111}}
h1{{font-size:20px}} h2{{font-size:15px;margin-top:28px}}
table{{border-collapse:collapse;margin:10px 0 4px}}
th,td{{border:1px solid #ddd;padding:4px 8px;font-family:monospace;font-size:12px;text-align:right}}
th:first-child,td:first-child{{text-align:left}}
svg{{margin:8px 0 4px}}
</style></head><body>
<h1>graphify perf-lab results</h1>
<p>redraw_min aggregated as min across reps; load_ms min; pan_fps max. bars sorted best-first.</p>
{''.join(sections)}
</body></html>"""
    open(OUT, "w", encoding="utf-8").write(doc)
    print("wrote", OUT, len(doc), "bytes")

    # compact hero page for inline viewing: rsl dpr=1 (largest mid-size graph measured)
    hero_g, hero_d = "rsl", "1"
    hero = [(v, a) for (g, d, v), a in agg.items() if g == hero_g and d == hero_d]
    if hero:
        hero.sort(key=lambda x: x[1]["redraw_min"])
        bv = next((a["redraw_min"] for v, a in hero if v == "v00-baseline"), hero[0][1]["redraw_min"])
        nodes, edges = hero[0][1]["nodes"], hero[0][1]["edges"]
        red = [(v, a["redraw_min"] / bv) for v, a in hero]
        ld = sorted([(v, a["load_ms"]) for v, a in hero], key=lambda x: x[1])
        sdoc = f"""<!doctype html><html><head><meta charset="utf-8"></head><body style="font:13px/1.4 system-ui,Segoe UI,sans-serif;color:var(--foreground,#111)">
<div style="font-size:15px;font-weight:600;margin-bottom:2px">{hero_g}: {nodes} nodes / {edges} edges &middot; dpr={hero_d}</div>
<div style="opacity:.6;margin-bottom:10px">relative cost per canvas redraw (1.00 = shipped baseline). arrows-on-hover keeps direction on hover; no-sim removes on-load stabilization.</div>
{bars(red, width=680, title="redraw vs baseline", fmt="{v:.2f}", base_val=1.0, base_label="v00-baseline")}
{bars(ld, width=680, title="load_ms", fmt="{v:.0f}", base_label="v00-baseline")}
</body></html>"""
        sp = os.path.join(LAB, "results", "summary.html")
        open(sp, "w", encoding="utf-8").write(sdoc)
        print("wrote", sp, len(sdoc), "bytes")


if __name__ == "__main__":
    main()
