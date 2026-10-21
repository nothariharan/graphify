// Layout quality for a first-open variant: the open time can be cut, but only if the
// picture stays the same. This probe reads the stabilized positions out of the page and
// reports metrics that describe "does this look like a graph".
//
//   node harness/probe_layout.mjs --file variants/base-ours-v10.html --shot shots/L17-ref.png
//
// Metrics
//   edgeLenMedian / p90   - how long the edges are
//   intraInter             - median intra-community edge length / median inter-community
//                           edge length (lower = communities hold together better)
//   sepRatio               - median distance between community centroids / median radius
//                           of a community (higher = communities are further apart)
//   crossings              - exact count of edge pairs that cross (segment intersection,
//                           shared endpoints excluded)
//   shortEdges             - edges shorter than 25 units (nodes sitting on top of each other)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FILE = arg('file');
const SHOT = arg('shot', '');

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8262, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
await page.goto('http://127.0.0.1:8262/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try {
    return network.physics.options.enabled === false && network.body &&
      Object.keys(network.body.nodes).length > 0;
  } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(600);

const m = await page.evaluate(() => {
  const pos = network.getPositions();
  const comm = {};
  nodesDS.get().forEach((n) => { comm[n.id] = n.community; });
  const idOf = new Map();
  edgesDS.get().forEach((e) => {
    idOf.set(e.id, e.from);
    idOf.set(e.id + '|to', e.to);
  });
  const edges = edgesDS.get().map((e) => ({
    from: e.from, to: e.to,
    x1: pos[e.from] && pos[e.from].x, y1: pos[e.from] && pos[e.from].y,
    x2: pos[e.to] && pos[e.to].x, y2: pos[e.to] && pos[e.to].y,
  })).filter((e) => e.x1 !== undefined && e.x2 !== undefined);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const len = (e) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

  const lens = edges.map(len);
  const intra = [], inter = [];
  for (const e of edges) {
    const c1 = comm[e.from], c2 = comm[e.to];
    (c1 === c2 ? intra : inter).push(len(e));
  }
  // community centroids and radii
  const byC = new Map();
  for (const id in pos) {
    const c = comm[id];
    if (c === undefined) continue;
    if (!byC.has(c)) byC.set(c, []);
    byC.get(c).push(pos[id]);
  }
  const cents = [];
  for (const [c, ps] of byC) {
    const cx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const cy = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    const rad = med(ps.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    cents.push({ c, cx, cy, rad, n: ps.length });
  }
  const centDist = [];
  for (let i = 0; i < cents.length; i++) {
    for (let j = i + 1; j < cents.length; j++) {
      centDist.push(Math.hypot(cents[i].cx - cents[j].cx, cents[i].cy - cents[j].cy) / (cents[i].rad + cents[j].rad + 1));
    }
  }
  // edge crossings (exact, shared endpoints excluded)
  const cross = (a, b) => {
    const d = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const d1 = d(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
    const d2 = d(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
    const d3 = d(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
    const d4 = d(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const b = edges[j];
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      if (cross(a, b)) crossings++;
    }
  }
  const shortEdges = lens.filter((l) => l < 25).length;
  return {
    nodes: Object.keys(pos).length, edges: edges.length,
    edgeLenMedian: +med(lens).toFixed(1), edgeLenP90: +pct(lens, 0.9).toFixed(1),
    intraMedian: +med(intra).toFixed(1), interMedian: +med(inter).toFixed(1),
    intraInter: +(med(intra) / Math.max(1, med(inter))).toFixed(3),
    sepRatio: +med(centDist).toFixed(2),
    crossings, shortEdges,
    spread: +med(Object.values(pos).map((p) => Math.hypot(p.x, p.y))).toFixed(1),
  };
});

if (SHOT) await page.screenshot({ path: path.join(LAB, SHOT) });
console.log(JSON.stringify({ file: path.basename(FILE), ...m, errors: errors.slice(0, 3) }));
await browser.close();
srv.close();
