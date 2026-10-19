#!/usr/bin/env python
"""Build performance-test variants from a generated graph.html.

No change to the real exporter: each variant is the shipped artifact plus a small,
targeted patch, so the measured delta is attributable to that lever alone.
Capability (node/edge/community counts) is preserved unless the lever says so.
"""
import argparse, os, re, io

LOCAL_VIS = '<script src="/data/vis-network.min.js"></script>'

# --- levers (string patches on the emitted template) ---
P = {
    "physics_off":   (r"(\n\s*physics: \{\n\s*)enabled: true,", r"\1enabled: false,"),
    "no_stab":       (r"stabilization: \{ iterations: 200, fit: true \},", "stabilization: false,"),
    "no_arrows":     (r"arrows: \{ to: \{ enabled: true, scaleFactor: 0\.5 \} \},", "arrows: { to: { enabled: false } },"),
    "no_dash":       (r"dashes: e\.dashes,", "dashes: false,"),
    "straight":      (r"smooth: \{ type: 'continuous', roundness: 0\.2 \}", "smooth: { enabled: false }"),
    "no_hover":      (r"(\n\s*)hover: true,", r"\1hover: false,"),
    "no_improved":   (r"(\n\s*physics: \{\n)", r"\n    improvedLayout: false,\1"),
    "arrow_vee":     (r"arrows: \{ to: \{ enabled: true, scaleFactor: 0\.5 \} \},", "arrows: { to: { enabled: true, scaleFactor: 0.5, type: 'vee' } },"),
    "arrow_bar":     (r"arrows: \{ to: \{ enabled: true, scaleFactor: 0\.5 \} \},", "arrows: { to: { enabled: true, scaleFactor: 0.5, type: 'bar' } },"),
    "arrow_circle":  (r"arrows: \{ to: \{ enabled: true, scaleFactor: 0\.5 \} \},", "arrows: { to: { enabled: true, scaleFactor: 0.5, type: 'circle' } },"),
    "smooth_dynamic":  (r"smooth: \{ type: 'continuous', roundness: 0\.2 \}", "smooth: { type: 'dynamic' }"),
    "smooth_discrete": (r"smooth: \{ type: 'continuous', roundness: 0\.2 \}", "smooth: { type: 'discrete' }"),
}

# injected (post-build) scripts
INJECT = {
    "labels_off": """
(function(){var t=setInterval(function(){if(typeof nodesDS!=='undefined'&&typeof network!=='undefined'){clearInterval(t);
nodesDS.update(RAW_NODES.map(function(n){return {id:n.id,font:Object.assign({},n.font,{size:0})};}));}},5);})();""",
    "labels_lod": """
(function(){var K=Math.max(50,Math.round(RAW_NODES.length*0.08));var t=setInterval(function(){if(typeof nodesDS!=='undefined'&&typeof network!=='undefined'){clearInterval(t);
var s=RAW_NODES.slice().sort(function(a,b){return (b.degree||0)-(a.degree||0);});var keep={};s.slice(0,K).forEach(function(n){keep[n.id]=1;});
nodesDS.update(RAW_NODES.map(function(n){return {id:n.id,font:Object.assign({},n.font,{size:keep[n.id]?n.font.size:0})};}));}},5);})();""",
    "dpr_force1": """
(function(){try{Object.defineProperty(window,'devicePixelRatio',{get:function(){return 1;}});}catch(e){}})();""",
    "arrows_on_hover": """
(function(){var t=setInterval(function(){if(typeof edgesDS!=='undefined'&&typeof network!=='undefined'){clearInterval(t);
network.on('hoverEdge',function(p){try{edgesDS.update({id:p.edge,arrows:{to:{enabled:true,scaleFactor:0.5}}});}catch(e){}});
network.on('blurEdge',function(p){try{edgesDS.update({id:p.edge,arrows:{to:{enabled:false}}});}catch(e){}});
}},5);})();""",
}

# variant -> (list of P keys, list of INJECT keys)
VARIANTS = {
    "v00-baseline":   ([], []),
    "v01-nosim":      (["physics_off", "no_stab"], []),
    "v02-noarrows":   (["no_arrows"], []),
    "v03-nodash":     (["no_dash"], []),
    "v04-straight":   (["straight"], []),
    "v05-nohover":    (["no_hover"], []),
    "v06-nolabels":   ([], ["labels_off"]),
    "v07-lodlabels":  ([], ["labels_lod"]),
    "v08-noimproved": (["no_improved"], []),
    "v09-dpr1":       ([], ["dpr_force1"]),
    "v10-lean":       (["physics_off", "no_stab", "no_arrows", "no_dash", "straight", "no_hover", "no_improved"], ["labels_lod"]),
    "v11-lean-dpr1":  (["physics_off", "no_stab", "no_arrows", "no_dash", "straight", "no_hover", "no_improved"], ["labels_lod", "dpr_force1"]),
    "v12-edges-lean": (["no_arrows", "no_dash", "straight"], []),
    "v13-hover-arrows": (["no_arrows"], ["arrows_on_hover"]),
    "v14-arrow-vee":    (["arrow_vee"], []),
    "v15-arrow-bar":    (["arrow_bar"], []),
    "v16-arrow-circle": (["arrow_circle"], []),
    "v17-smooth-dynamic":  (["smooth_dynamic"], []),
    "v18-smooth-discrete": (["smooth_discrete"], []),
    # capability-preserving dense-graph combo: straight edges (drop the curved
    # smoothing only) + direction revealed on hover. Keeps dashes/confidence.
    "v21-hover-straight": (["no_arrows", "straight"], ["arrows_on_hover"]),
}


def build(base_html: str, pkeys, ikeys) -> str:
    html = base_html
    # localize the CDN so load timing excludes network latency and works offline
    html = re.sub(r'<script src="https://unpkg\.com/vis-network[^>]*></script>', LOCAL_VIS, html, count=1)
    for k in pkeys:
        pat, rep = P[k]
        if not pat:
            continue
        html, n = re.subn(pat, rep, html, count=1)
        if n == 0:
            raise SystemExit(f"patch {k} did not match")
    if ikeys:
        inject = "\n".join("<script>" + INJECT[k] + "</script>" for k in ikeys)
        html = html.replace("</body>", inject + "\n</body>", 1)
    return html


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    base = io.open(a.base, encoding="utf-8").read()
    only = set(x for x in a.only.split(",") if x)
    os.makedirs(a.outdir, exist_ok=True)
    written = []
    for name, (pk, ik) in VARIANTS.items():
        if only and name not in only:
            continue
        out = build(base, pk, ik)
        fp = os.path.join(a.outdir, f"{a.prefix}__{name}.html")
        io.open(fp, "w", encoding="utf-8").write(out)
        written.append((name, len(out)))
    for n, s in written:
        print(f"  {a.prefix}__{n}.html  {s//1024} KB")


if __name__ == "__main__":
    main()
