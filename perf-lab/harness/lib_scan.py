"""Scan candidate renderers for an Obsidian-class graph view.

  python harness/lib_scan.py

Fetches npm + GitHub metadata (read-only) for graphing libraries and writes a
table to results/lib-scan.txt. Network is used only for public registry reads.
"""
import io, json, os, sys, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
OUT = os.path.join(LAB, "results", "lib-scan.txt")

NPM = ["sigma", "graphology", "@cosmograph/cosmos", "cosmograph", "@antv/g6",
       "cytoscape", "force-graph", "3d-force-graph", "react-force-graph-2d",
       "vis-network", "pixi.js", "echarts", "d3-force", "regl", "ngraph.forcelayout"]
GH = ["jacomyal/sigma.js", "cosmograph-org/cosmograph", "antvis/G6",
      "vasturiano/force-graph", "vasturiano/3d-force-graph", "cytoscape/cytoscape.js",
      "graphology/graphology", "pixijs/pixijs", "FBarrca/obsidian-extended-graph"]


def get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "graphify-perf-lab"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


lines = []


def out(s=""):
    lines.append(s)
    print(s)


out("== npm ==")
out(f"{'package':<24} {'version':<12} {'week':>9}  description")
for name in NPM:
    ver = desc = err = ""
    week = ""
    try:
        d = get("https://registry.npmjs.org/" + urllib.parse.quote(name, safe="") + "/latest")
        ver = d.get("version", "")
        desc = (d.get("description") or "")[:70]
    except Exception as e:
        err = str(e)[:40]
    try:
        w = get("https://api.npmjs.org/downloads/point/last-week/" + urllib.parse.quote(name, safe=""))
        week = w.get("downloads", "")
    except Exception:
        pass
    out(f"{name:<24} {ver:<12} {str(week):>9}  {desc or err}")

out()
out("== github ==")
out(f"{'repo':<34} {'stars':>7} {'issues':>7} {'pushed':<12} {'lic':<10} archived  description")
for full in GH:
    try:
        d = get("https://api.github.com/repos/" + full)
        lic = ((d.get("license") or {}).get("spdx_id") or "")
        out(f"{full:<34} {d.get('stargazers_count',0):>7} {d.get('open_issues_count',0):>7} "
            f"{(d.get('pushed_at') or '')[:10]:<12} {lic:<10} {str(d.get('archived')):<9} "
            f"{(d.get('description') or '')[:60]}")
    except Exception as e:
        out(f"{full:<34} ERROR {str(e)[:60]}")

out()
out("== github search: obsidian graph webgl ==")
for q in ["obsidian+graph+webgl", "graph+view+webgl+wasm", "large+graph+visualization+webgl"]:
    try:
        d = get("https://api.github.com/search/repositories?q=" + q + "&sort=stars&per_page=8")
        out(f"-- {q}")
        for it in d.get("items", [])[:8]:
            out(f"   {it['full_name']:<40} {it.get('stargazers_count',0):>7}  {(it.get('description') or '')[:60]}")
    except Exception as e:
        out(f"-- {q} ERROR {str(e)[:60]}")

io.open(OUT, "w", encoding="utf-8").write("\n".join(lines))
print("\nwrote", OUT)
