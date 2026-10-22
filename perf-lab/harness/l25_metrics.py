"""L25 — the layout metrics kernel.

Scores a *point cloud* (positions + community + edges), not a build, so the browser's
stabilized layout and a numpy-baked layout are measured by the same code on the same graph.

    python harness/l25_metrics.py --dump results/l25-rsl-browser.json
    python harness/l25_metrics.py --dump results/l25-rsl-np.json --json results/l25-rsl-np-metrics.json

Everything is derived from the dump:
  node id -> (x, y), community, degree, size, font size
  edge list (from, to)
  canvas w/h and the real fit scale (from the page, so the px numbers are the user's px)

Metric definitions (kept identical to harness/probe_layout.mjs where they overlap, so the
two instruments can be cross-checked):
  edgeLen*        world units
  intraInter      median intra-community edge length / median inter-community edge length
  sepRatio        median over community pairs of centroid distance / (rad_i + rad_j + 1)
  crossings       exact segment intersection, shared-endpoint pairs excluded
  shortEdges      edge length < 25 world units
Extended (this lane):
  aspect          bbox width / bbox height (1.0 == isotropic)
  spread          median edge length / sqrt(bbox area); scale-free, survives network.fit
  edge_px         median edge length on screen at the measured fit scale
  dot_px          median node dot diameter on screen at the measured fit scale
  fill            painted bbox area / canvas area after fit (how much of the frame is used)
  ink             area covered by node dots / canvas area
  nn_px           median nearest-neighbour distance on screen (does it read as dots?)
  colour          adjacency-aware audit of the cid % 10 assignment + a greedy alternative
  labels          the degree gate, on-screen px at fit, overlap counts at a readable zoom
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics as st

import numpy as np

PALETTE = [
    "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
    "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
]

FIT_PADDING = 0.15      # vis Network.fit() default
LABEL_READ_PX = 7.0     # a 12 px label is legible from ~7 px up; below that it is a smear


# --------------------------------------------------------------------------- load
class Layout:
    def __init__(self, d: dict):
        self.raw = d
        self.nodes = d["nodes"]
        self.edges = [(str(a), str(b)) for a, b in d["edges"]]
        self.ids = [n["id"] for n in self.nodes]
        self.index = {nid: i for i, nid in enumerate(self.ids)}
        pos = d["positions"]
        n = len(self.ids)
        self.xy = np.zeros((n, 2), dtype=np.float64)
        for i, nid in enumerate(self.ids):
            p = pos[nid]
            self.xy[i] = (p[0], p[1])
        self.comm = np.array([n.get("community", -1) for n in self.nodes], dtype=np.int64)
        self.degree = np.array([n.get("degree", 0) or 0 for n in self.nodes], dtype=np.float64)
        self.size = np.array([n.get("size", 10) or 10 for n in self.nodes], dtype=np.float64)
        self.font = np.array([n.get("font", 0) or 0 for n in self.nodes], dtype=np.float64)
        self.canvas = d.get("canvas") or {"w": 1000, "h": 800}
        self.scale = d.get("scale")

        ei = [(self.index[a], self.index[b]) for a, b in self.edges
              if a in self.index and b in self.index]
        self.ei = np.array(ei, dtype=np.int64) if ei else np.zeros((0, 2), dtype=np.int64)


# --------------------------------------------------------------------------- geometry
def bbox(xy):
    lo = xy.min(axis=0)
    hi = xy.max(axis=0)
    return lo, hi, (hi - lo)


def edge_lengths(L: Layout):
    if len(L.ei) == 0:
        return np.zeros(0)
    p = L.xy[L.ei[:, 0]]
    q = L.xy[L.ei[:, 1]]
    return np.hypot(*(q - p).T)


def crossings(L: Layout, chunk: int = 256) -> int:
    """Exact segment-pair intersections, shared endpoints excluded (same rule as the JS probe)."""
    e = L.ei
    m = len(e)
    if m < 2:
        return 0
    p = L.xy[e[:, 0]]
    q = L.xy[e[:, 1]]
    total = 0
    for i0 in range(0, m, chunk):
        i1 = min(m, i0 + chunk)
        a0 = p[i0:i1, None, :]
        a1 = q[i0:i1, None, :]
        b0 = p[None, :, :]
        b1 = q[None, :, :]
        d1 = (a1[..., 0] - a0[..., 0]) * (b0[..., 1] - a0[..., 1]) - \
             (a1[..., 1] - a0[..., 1]) * (b0[..., 0] - a0[..., 0])
        d2 = (a1[..., 0] - a0[..., 0]) * (b1[..., 1] - a0[..., 1]) - \
             (a1[..., 1] - a0[..., 1]) * (b1[..., 0] - a0[..., 0])
        d3 = (b1[..., 0] - b0[..., 0]) * (a0[..., 1] - b0[..., 1]) - \
             (b1[..., 1] - b0[..., 1]) * (a0[..., 0] - b0[..., 0])
        d4 = (b1[..., 0] - b0[..., 0]) * (a1[..., 1] - b0[..., 1]) - \
             (b1[..., 1] - b0[..., 1]) * (a1[..., 0] - b0[..., 0])
        hit = ((d1 > 0) != (d2 > 0)) & ((d3 > 0) != (d4 > 0))
        # only count pairs i<j, and drop pairs that share an endpoint
        jj = np.arange(m)[None, :]
        ii = np.arange(i0, i1)[:, None]
        hit &= jj > ii
        sh = (e[i0:i1, 0][:, None] == e[None, :, 0]) | (e[i0:i1, 0][:, None] == e[None, :, 1]) | \
             (e[i0:i1, 1][:, None] == e[None, :, 0]) | (e[i0:i1, 1][:, None] == e[None, :, 1])
        hit &= ~sh
        total += int(hit.sum())
    return total


def communities(L: Layout):
    ids = sorted(set(int(c) for c in L.comm))
    out = {}
    for c in ids:
        mask = L.comm == c
        pts = L.xy[mask]
        cx, cy = pts.mean(axis=0)
        d = np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)
        out[c] = {
            "n": int(mask.sum()),
            "cx": float(cx), "cy": float(cy),
            "rad": float(np.median(d)),
            "r90": float(np.percentile(d, 90)),
        }
    return out


def nearest_neighbour_px(xy, chunk: int = 512) -> float:
    n = len(xy)
    if n < 2:
        return 0.0
    nn = np.full(n, np.inf)
    for i0 in range(0, n, chunk):
        i1 = min(n, i0 + chunk)
        d = np.hypot(xy[i0:i1, None, 0] - xy[None, :, 0],
                     xy[i0:i1, None, 1] - xy[None, :, 1])
        idx = np.arange(i0, i1)
        d[np.arange(i1 - i0), idx] = np.inf
        nn[i0:i1] = d.min(axis=1)
    return float(np.median(nn))


# --------------------------------------------------------------------------- colours
def colour_audit(L: Layout, comm: dict):
    sizes = {c: v["n"] for c, v in comm.items()}
    cur = {c: c % len(PALETTE) for c in sizes}

    # structural adjacency between communities (edge counts)
    adj = {}
    for a, b in L.ei:
        ca, cb = int(L.comm[a]), int(L.comm[b])
        if ca == cb:
            continue
        k = (min(ca, cb), max(ca, cb))
        adj[k] = adj.get(k, 0) + 1

    def collisions(assign):
        pairs = list(adj.keys())
        if not pairs:
            return dict(pairs=0, colliding=0, rate=0.0, weight=0, weight_coll=0.0)
        coll = [p for p in pairs if assign[p[0]] == assign[p[1]]]
        w = sum(adj[p] for p in pairs)
        wc = sum(adj[p] for p in coll)
        return dict(pairs=len(pairs), colliding=len(coll),
                    rate=round(len(coll) / len(pairs), 4),
                    weight=w, weight_rate=round(wc / max(1, w), 4))

    # greedy adjacency-aware colouring, biggest community first
    nbrs = {c: {} for c in sizes}
    for (a, b), n in adj.items():
        nbrs[a][b] = nbrs[a].get(b, 0) + n
        nbrs[b][a] = nbrs[b].get(a, 0) + n
    order = sorted(sizes, key=lambda c: (-sizes[c], c))
    greedy = {}
    for c in order:
        cost = [0.0] * len(PALETTE)
        for nb, w in nbrs[c].items():
            if nb in greedy:
                cost[greedy[nb]] += w
        best = min(range(len(PALETTE)), key=lambda k: (cost[k], k))
        greedy[c] = best

    # size-ordered: the 10 biggest communities get the 10 colours, then cid % 10 again
    by_size = sorted(sizes, key=lambda c: (-sizes[c], c))
    sizeorder = {c: (i % len(PALETTE) if i < len(PALETTE) else c % len(PALETTE))
                 for i, c in enumerate(by_size)}

    per_colour = {}
    for c, k in cur.items():
        e = per_colour.setdefault(k, {"communities": 0, "nodes": 0, "biggest": 0})
        e["communities"] += 1
        e["nodes"] += sizes[c]
        e["biggest"] = max(e["biggest"], sizes[c])

    top10 = [(c, sizes[c], PALETTE[cur[c]]) for c in by_size[:10]]
    top10_dup = len({cur[c] for c, _, _ in top10}) != len(top10)

    # how far apart are two same-coloured adjacent communities, in px at fit?
    lo, hi, wh = bbox(L.xy)
    scale = L.scale or min(L.canvas["w"] / (wh[0] * (1 + FIT_PADDING)),
                           L.canvas["h"] / (wh[1] * (1 + FIT_PADDING)))
    coll_sep = []
    for p in adj:
        if cur[p[0]] == cur[p[1]]:
            a, b = comm[p[0]], comm[p[1]]
            coll_sep.append(math.hypot(a["cx"] - b["cx"], a["cy"] - b["cy"]) * scale)

    # is colour already carrying size information? (cid order vs size)
    cid = np.array(sorted(sizes))
    sz = np.array([sizes[c] for c in sorted(sizes)], dtype=float)
    rank_c = np.argsort(np.argsort(cid)).astype(float)
    rank_s = np.argsort(np.argsort(sz)).astype(float)
    rho = float(np.corrcoef(rank_c, rank_s)[0, 1]) if len(cid) > 2 else 0.0

    return {
        "palette": len(PALETTE),
        "communities": len(sizes),
        "communities_per_colour_median": round(st.median(
            [v["communities"] for v in per_colour.values()]), 2),
        "nodes_per_colour": {PALETTE[k]: v["nodes"] for k, v in sorted(per_colour.items())},
        "colour_share_max": round(max(v["nodes"] for v in per_colour.values()) / max(1, sum(sizes.values())), 3),
        "current": collisions(cur),
        "greedy": collisions(greedy),
        "sizeordered": collisions(sizeorder),
        "top10_same_colour": top10_dup,
        "top10": [{"community": c, "nodes": n, "colour": col} for c, n, col in top10],
        "colliding_pair_sep_px_median": round(st.median(coll_sep), 1) if coll_sep else None,
        "cid_vs_size_spearman": round(rho, 3),
    }


# --------------------------------------------------------------------------- labels
def label_audit(L: Layout, scale: float):
    lab = np.where(L.font > 0)[0]
    if len(lab) == 0:
        return {"labelled": 0}
    maxdeg = float(L.degree.max()) if len(L.degree) else 1.0
    px = L.font[lab] * scale
    # label box in world units at fit: width ~ 0.58 * font * len, centred on the node
    texts = [L.nodes[i].get("label") or "" for i in lab]
    world_font = L.font[lab] / max(scale, 1e-9)   # font is already px-at-scale-1 == world units

    def overlaps(s: float, view_w: float, view_h: float):
        cw = [L.canvas["w"] / s, L.canvas["h"] / s]
        keep = []
        for k, i in enumerate(lab):
            x, y = L.xy[i]
            if abs(x) <= cw[0] / 2 and abs(y) <= cw[1] / 2:   # inside the fitted view
                keep.append(k)
        boxes = []
        for k in keep:
            f = world_font[k]
            w = 0.58 * f * max(1, len(texts[k]))
            boxes.append((L.xy[lab[k]][0] - w / 2, L.xy[lab[k]][1] - f / 2,
                          L.xy[lab[k]][0] + w / 2, L.xy[lab[k]][1] + f / 2))
        hits = 0
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                    hits += 1
        return len(keep), hits

    in_fit, ov_fit = overlaps(scale, L.canvas["w"], L.canvas["h"])
    read_s = LABEL_READ_PX / 12.0
    in_read, ov_read = overlaps(read_s, L.canvas["w"], L.canvas["h"])
    return {
        "labelled": int(len(lab)),
        "labelled_share": round(len(lab) / max(1, len(L.ids)), 4),
        "degree_max": int(maxdeg),
        "gate_label": round(maxdeg * 0.15, 2),
        "degree_min_labelled": int(L.degree[lab].min()),
        "font_px_at_fit": round(float(np.median(px)), 2),
        "font_px_max_at_fit": round(float(px.max()), 2),
        "legible_scale": round(read_s, 3),
        "labelled_in_view_at_fit": in_fit,
        "label_overlaps_at_fit": ov_fit,
        "labelled_in_view_at_legible_scale": in_read,
        "label_overlaps_at_legible_scale": ov_read,
    }


# --------------------------------------------------------------------------- report
def score(L: Layout) -> dict:
    lo, hi, wh = bbox(L.xy)
    area = float(wh[0] * wh[1])
    lens = edge_lengths(L)
    e = L.ei
    same = L.comm[e[:, 0]] == L.comm[e[:, 1]] if len(e) else np.zeros(0, bool)
    intra = lens[same] if len(e) else np.zeros(0)
    inter = lens[~same] if len(e) else np.zeros(0)
    comm = communities(L)

    cw, ch = L.canvas["w"], L.canvas["h"]
    scale = L.scale
    scale_expected = min(cw / (wh[0] * (1 + FIT_PADDING)), ch / (wh[1] * (1 + FIT_PADDING)))
    s = scale if scale else scale_expected

    cent = list(comm.values())
    pairs = []
    for i in range(len(cent)):
        for j in range(i + 1, len(cent)):
            a, b = cent[i], cent[j]
            pairs.append(math.hypot(a["cx"] - b["cx"], a["cy"] - b["cy"]) /
                         (a["rad"] + b["rad"] + 1))

    nn = nearest_neighbour_px(L.xy)
    painted_w, painted_h = wh[0] * s, wh[1] * s
    dot_px = L.size * s
    ink = float((np.pi * (dot_px / 2) ** 2).sum() / (cw * ch))

    return {
        "source": L.raw.get("source", "?"),
        "file": L.raw.get("file", "?"),
        "ready_ms": L.raw.get("ready_ms"),
        "canvas": {"w": cw, "h": ch, "aspect": round(cw / ch, 3)},
        "nodes": len(L.ids), "edges": len(e), "communities": len(comm),
        "bbox_w": round(float(wh[0]), 1), "bbox_h": round(float(wh[1]), 1),
        "aspect": round(float(wh[0] / wh[1]), 3),
        "area": round(area, 1),
        "fit_scale": round(float(s), 5),
        "fit_scale_expected": round(float(scale_expected), 5),
        "edgeLenMedian": round(float(np.median(lens)), 1) if len(lens) else 0,
        "edgeLenP90": round(float(np.percentile(lens, 90)), 1) if len(lens) else 0,
        "spread_ratio": round(float(np.median(lens) / math.sqrt(area)), 4) if len(lens) and area else 0,
        "edge_px": round(float(np.median(lens) * s), 2) if len(lens) else 0,
        "dot_px_median": round(float(np.median(dot_px)), 2),
        "dot_px_p90": round(float(np.percentile(dot_px, 90)), 2),
        "nn_px": round(nn * s, 2),
        "fill": round(float(painted_w * painted_h / (cw * ch)), 3),
        "fill_w": round(float(painted_w / cw), 3),
        "fill_h": round(float(painted_h / ch), 3),
        "ink": round(ink, 4),
        "intraMedian": round(float(np.median(intra)), 1) if len(intra) else 0,
        "interMedian": round(float(np.median(inter)), 1) if len(inter) else 0,
        "intraInter": round(float(np.median(intra) / max(1.0, np.median(inter))), 3) if len(intra) and len(inter) else 0,
        "sepRatio": round(float(np.median(pairs)), 2) if pairs else 0,
        "crossings": crossings(L),
        "shortEdges": int((lens < 25).sum()),
        "colour": colour_audit(L, comm),
        "labels": label_audit(L, s),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--json", default="")
    ap.add_argument("--csv", default="")
    a = ap.parse_args()
    d = json.load(open(a.dump, encoding="utf-8"))
    r = score(Layout(d))
    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)), exist_ok=True)
        json.dump(r, open(a.json, "w", encoding="utf-8"), indent=1)
    if a.csv:
        flat = {k: v for k, v in r.items() if not isinstance(v, (dict, list))}
        new = not os.path.exists(a.csv)
        with open(a.csv, "a", encoding="utf-8", newline="") as f:
            import csv
            w = csv.DictWriter(f, fieldnames=list(flat.keys()))
            if new:
                w.writeheader()
            w.writerow(flat)
    print(json.dumps(r, indent=1))


if __name__ == "__main__":
    main()
