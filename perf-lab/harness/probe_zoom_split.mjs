// Zoomed into the dense centre: where does the frame go, and how much of what we draw is
// even on screen?
//
//   node harness/probe_zoom_split.mjs --file variants/base-ours-v16.html
//
// For the fit view and 2x/4x/8x fit, centred on the densest node cluster:
//   - frame cost with the shipped draw
//   - with every node shape stubbed (the node pass)
//   - with the edge batch uninstalled (vis draws the edges one by one)
//   - how many nodes and how many edge endpoints are actually inside the viewport
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

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8280, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8280/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const cv = document.querySelector('#graph canvas');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : 0; };

  const nodes = network.body.nodes;
  const pos = network.getPositions();
  // densest node: the one with the most neighbours within a radius of 30 world units
  const ids = Object.keys(nodes);
  let best = ids[0], bestN = -1;
  for (const id of ids) {
    const p = pos[id];
    if (!p) continue;
    let n = 0;
    for (const other of ids) {
      const q = pos[other];
      if (q && Math.hypot(q.x - p.x, q.y - p.y) < 260) n++;
    }
    if (n > bestN) { bestN = n; best = id; }
  }
  const centre = pos[best];
  const fit = network.getScale();

  // stub the node shapes / uninstall the edge batch
  const shapes = [];
  for (const id of ids) {
    const n = nodes[id];
    if (n && n.shape && typeof n.shape.draw === 'function') shapes.push([n.shape, n.shape.draw]);
  }
  const setShapes = (on) => { for (const [s, fn] of shapes) s.draw = on ? fn : function () {}; };
  const setRest = (on) => { try { _EDGE_BATCH.setRest(on); } catch (e) {} };
  // the labels are drawn by node.draw after the shape, so stubbing shape.draw leaves
  // them in the frame; this switches them off to see what they cost
  const fonts = [];
  for (const id of ids) {
    const n = nodes[id];
    if (n && n.options && n.options.font) fonts.push([n.options.font, n.options.font.size]);
  }
  const setFonts = (on) => { for (const [f, size] of fonts) f.size = on ? size : 0; };

  async function frameMs() {
    const one = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
    // warm-up, discarded
    for (let i = 0; i < 3; i++) { network.redraw(); await one(); }
    const samples = [];
    let last = await one();
    for (let i = 0; i < 14; i++) {
      network.redraw();
      const t = await one();
      samples.push(t - last);
      last = t;
    }
    return med(samples);
  }

  function visibleCounts() {
    const w = cv.width, h = cv.height;
    const scale = network.getScale();
    const view = network.getViewPosition();
    const sx = (x) => w / 2 + (x - view.x) * scale;
    const sy = (y) => h / 2 + (y - view.y) * scale;
    let n = 0;
    for (const id of ids) { const p = pos[id]; if (!p) continue; const X = sx(p.x), Y = sy(p.y); if (X >= 0 && Y >= 0 && X <= w && Y <= h) n++; }
    let e = 0;
    for (const id in network.body.edges) {
      const ed = network.body.edges[id];
      if (!ed) continue;
      const a = pos[ed.fromId] || pos[ed.from];
      const b = pos[ed.toId] || pos[ed.to];
      if (!a || !b) continue;
      // the segment's bbox against the viewport
      const x1 = sx(a.x), y1 = sy(a.y), x2 = sx(b.x), y2 = sy(b.y);
      if (Math.max(x1, x2) >= 0 && Math.max(y1, y2) >= 0 && Math.min(x1, x2) <= w && Math.min(y1, y2) <= h) e++;
    }
    return { nodes: n, edges: e };
  }

  const rows = [];
  for (const mult of [1, 2, 4, 8, 12, 24]) {
    const scale = Math.min(2.0, fit * mult);
    network.moveTo({ position: { x: centre.x, y: centre.y }, scale: scale, animation: false });
    await wait(500);
    const counts = visibleCounts();
    setFonts(true); setShapes(true); setRest(true);
    const normal = await frameMs();
    setShapes(false); setRest(true);
    const noNodes = await frameMs();
    setShapes(true); setRest(false);
    const noEdges = await frameMs();
    setShapes(true); setRest(true); setFonts(false);
    const noLabels = await frameMs();
    setShapes(false); setRest(true); setFonts(false);
    const noNodesLabels = await frameMs();
    setFonts(true); setShapes(true); setRest(true);
    rows.push({ mult, scale: +scale.toFixed(4), ...counts, normal, noNodes, noEdges, noLabels, noNodesLabels });
  }
  return { densest: best, neighboursWithin260: bestN, rows, canvas: { w: cv.width, h: cv.height } };
});

console.log(`${path.basename(FILE)}  canvas ${out.canvas.w}x${out.canvas.h}  densest node ${out.densest} (${out.neighboursWithin260} neighbours within 260 units)`);
console.log(`  ${"zoom".padEnd(5)} ${"scale".padEnd(7)} ${"nodes".padStart(6)} ${"edges".padStart(6)} ${"frame".padStart(7)} ${"-nodes".padStart(8)} ${"-edges".padStart(8)} ${"-labels".padStart(8)} ${"-both".padStart(7)}`);
for (const r of out.rows) {
  console.log(`  ${("x" + r.mult).padEnd(5)} ${String(r.scale).padEnd(7)} ${String(r.nodes).padStart(6)} ${String(r.edges).padStart(6)} ${String(r.normal).padStart(7)} ${String(r.noNodes).padStart(8)} ${String(r.noEdges).padStart(8)} ${String(r.noLabels).padStart(8)} ${String(r.noNodesLabels).padStart(7)}`);
}
await browser.close();
srv.close();
