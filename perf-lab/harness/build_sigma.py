"""Build a sigma.js (WebGL) prototype from a graphify graph.json.

  python harness/build_sigma.py --graph-json worked/rsl-siege-manager/graph.json --name rsl

Writes variants/<name>__s00-sigma.html using the locally vendored sigma + graphology
(no CDN). Same capability set as the vis render: community colour, degree size, labels,
confidence-styled edges, hover highlight, click inspect.
"""
import argparse, io, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)

PALETTE = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7",
           "#eab308", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6", "#84cc16"]

HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>graphify - __TITLE__</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d12;color:#e5e7eb;
    font:13px/1.45 system-ui,Segoe UI,sans-serif;overflow:hidden}
  #c{position:fixed;inset:0}
  #hud{position:fixed;right:12px;top:12px;background:rgba(17,20,28,.82);border:1px solid #262b36;
    border-radius:8px;padding:8px 12px;font-variant-numeric:tabular-nums;z-index:5}
  #hud b{font-size:16px}
  #stats{position:fixed;left:12px;bottom:12px;opacity:.6;z-index:5}
  #info{position:fixed;left:12px;top:12px;background:rgba(17,20,28,.82);border:1px solid #262b36;
    border-radius:8px;padding:8px 12px;min-width:150px;z-index:5}
</style>
<script src="../data/graphology.umd.min.js"></script>
<script src="../data/sigma.min.js"></script>
</head>
<body>
<div id="c"></div>
<div id="info"><span style="opacity:.6">Click a node</span></div>
<div id="hud">fps <b id="fps">--</b><div id="eng" style="opacity:.55;font-size:11px">sigma webgl</div></div>
<div id="stats">__STATS__</div>
<script>
const RAW_NODES = __NODES__;
const RAW_EDGES = __EDGES__;

const G = new graphology.MultiGraph();
for (let i = 0; i < RAW_NODES.length; i++) {
  const n = RAW_NODES[i];
  G.addNode(n.id, {
    label: n.label, size: n.size, color: n.color,
    // golden-angle spiral seed, same as the vis render's seed
    x: 30 * Math.sqrt(i) * Math.cos(i * 2.4),
    y: 30 * Math.sqrt(i) * Math.sin(i * 2.4),
  });
}
for (const e of RAW_EDGES) {
  if (!G.hasNode(e.from) || !G.hasNode(e.to)) continue;
  try { G.addEdge(e.from, e.to, { color: e.color, size: e.size, zIndex: 0 }); } catch (err) {}
}

const renderer = new Sigma(G, document.getElementById('c'), {
  renderEdgeLabels: false,
  labelDensity: 0.12,
  labelRenderedSizeThreshold: 6,
  defaultEdgeColor: '#3a4152',
});

// hover highlight (sigma-native): neighbours stay lit, the rest dim
let hovered = null;
renderer.on('enterNode', ({ node }) => { hovered = node; renderer.refresh(); });
renderer.on('leaveNode', () => { hovered = null; renderer.refresh(); });
renderer.setSetting('nodeReducer', (node, data) => {
  if (hovered && node !== hovered) {
    const nb = G.neighbors(hovered);
    if (!nb.includes(node)) return { ...data, color: '#20242e', label: '' };
  }
  return data;
});

const info = document.getElementById('info');
renderer.on('clickNode', ({ node }) => {
  const d = G.getNodeAttributes(node);
  const nb = G.neighbors(node);
  info.innerHTML = '<b>' + (d.label || node) + '</b><br>degree ' + G.degree(node)
    + '<br><span style="opacity:.7">' + nb.slice(0, 8).join(', ') + (nb.length > 8 ? ' …' : '') + '</span>';
});

// live fps readout (the felt metric)
const fpsEl = document.getElementById('fps');
let frames = 0, t0 = performance.now();
(function tick() {
  frames++;
  const now = performance.now();
  if (now - t0 >= 500) { fpsEl.textContent = Math.round(frames * 1000 / (now - t0)); frames = 0; t0 = now; }
  requestAnimationFrame(tick);
})();

// expose for the measurement battery
window.graphologyGraph = G;
window.renderer = renderer;
window.network = { _sigma: true };
window.nodesDS = { length: G.order };
window.edgesDS = { length: G.size };
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--graph-json", required=True)
    ap.add_argument("--name", required=True)
    a = ap.parse_args()

    d = json.load(io.open(a.graph_json, encoding="utf-8"))
    nodes_in = d.get("nodes", [])
    links = d.get("links") or d.get("edges") or []

    deg = {}
    for e in links:
        s, t = e.get("source"), e.get("target")
        deg[s] = deg.get(s, 0) + 1
        deg[t] = deg.get(t, 0) + 1
    maxdeg = max(deg.values()) if deg else 1

    out_nodes = []
    for n in nodes_in:
        nid = n["id"]
        cid = int(n.get("community", 0) or 0)
        dg = deg.get(nid, 0)
        out_nodes.append({
            "id": nid,
            "label": (n.get("label") or nid)[:40],
            "size": round(2 + 10 * (dg / maxdeg), 2),
            "color": PALETTE[cid % len(PALETTE)],
        })

    out_edges = []
    for e in links:
        s, t = e.get("source"), e.get("target")
        if s is None or t is None:
            continue
        conf = str(e.get("confidence", "")).upper()
        out_edges.append({
            "from": s, "to": t,
            "size": 1.6 if conf == "EXTRACTED" else 0.8,
            "color": "#6b7280" if conf == "EXTRACTED" else "#3f4655",
        })

    comms = {int(n.get("community", 0) or 0) for n in nodes_in}
    stats = f"{len(out_nodes)} nodes &middot; {len(out_edges)} edges &middot; {len(comms)} communities"
    title = f"{a.name} (sigma prototype)"

    html = (HTML.replace("__NODES__", json.dumps(out_nodes))
                .replace("__EDGES__", json.dumps(out_edges))
                .replace("__STATS__", stats)
                .replace("__TITLE__", title))
    out = os.path.join(LAB, "variants", f"{a.name}__s00-sigma.html")
    io.open(out, "w", encoding="utf-8", newline="").write(html)
    print(f"wrote {out}  {os.path.getsize(out)//1024} KB  nodes={len(out_nodes)} edges={len(out_edges)} communities={len(comms)}")


if __name__ == "__main__":
    main()
