// Trace: at ONE fixed dense deep zoom, where does the synchronous draw go - in ours and in
// the official build, at the same camera?
//
//   node harness/probe_deep_split.mjs --file variants/base-ours-v23.html
//   node harness/probe_deep_split.mjs --file variants/base-official-v8.html
//
// The frame interval is vsync-quantised, so this times network.canvas.redraw() directly.
// Configs on ours: normal, edge batch uninstalled (vis draws the edges one by one), labels
// off (through the DataSet, so vis's label module honours it), node shapes stubbed, all.
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
const SCALE = String(arg('scale', '3'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8284, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8284/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async (scaleArg) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : 0; };
  const pos = network.getPositions();
  const ids = Object.keys(network.body.nodes);
  let best = ids[0], bestN = -1;
  for (const id of ids) {
    const p = pos[id];
    if (!p) continue;
    let n = 0;
    for (const o of ids) { const q = pos[o]; if (q && Math.hypot(q.x - p.x, q.y - p.y) < 260) n++; }
    if (n > bestN) { bestN = n; best = id; }
  }
  const c = pos[best];
  // the same camera in both builds: the densest node, at a deep zoom
  network.moveTo({ position: { x: c.x, y: c.y }, scale: parseFloat(scaleArg), animation: false });
  await wait(600);

  const shapes = [];
  for (const id of ids) {
    const n = network.body.nodes[id];
    if (n && n.shape && typeof n.shape.draw === 'function') shapes.push([n.shape, n.shape.draw]);
  }
  const setShapes = (on) => { for (const [s, fn] of shapes) s.draw = on ? fn : function () {}; };
  const hasBatch = (() => { try { return typeof _EDGE_BATCH !== 'undefined' && !!_EDGE_BATCH.setRest; } catch (e) { return false; } })();
  const setBatch = (on) => { if (hasBatch) { try { _EDGE_BATCH.setRest(on); } catch (e) {} } };

  // a synchronous draw: vis's Canvas listens on the body's private '_redraw' event, which
  // draws immediately (network.canvas has no redraw() in 9.1.6)
  const draw = () => {
    if (network.canvas && typeof network.canvas.redraw === 'function') network.canvas.redraw();
    else if (network.body && network.body.renderer && typeof network.body.renderer.redraw === 'function') network.body.renderer.redraw();
    else network.body.emitter.emit('_redraw');
  };
  async function drawMs() {
    const s = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      draw();
      s.push(performance.now() - t0);
    }
    return med(s.slice(3));
  }

  const r = { hasBatch, scale: +network.getScale().toFixed(3), nodes: 0, edges: 0 };
  const cv = document.querySelector('#graph canvas');
  const inView = (p) => {
    const v = network.getViewPosition(), k = network.getScale();
    const x = cv.width / 2 + (p.x - v.x) * k, y = cv.height / 2 + (p.y - v.y) * k;
    return x >= 0 && y >= 0 && x <= cv.width && y <= cv.height;
  };
  for (const id of ids) if (pos[id] && inView(pos[id])) r.nodes++;
  for (const id in network.body.edges) {
    const e = network.body.edges[id];
    if (!e) continue;
    const a = pos[e.fromId], b = pos[e.toId];
    if (a && b && (inView(a) || inView(b))) r.edges++;
  }

  setBatch(true); setShapes(true);
  r.normal = await drawMs();
  r.noBatch = hasBatch ? await (async () => { setBatch(false); const v = await drawMs(); setBatch(true); return v; })() : null;
  setShapes(false);
  r.noNodes = await drawMs();
  setShapes(true);
  // labels off through the DataSet: vis's label module only picks the font up from there
  try {
    nodesDS.update(nodesDS.get().map((n) => ({ id: n.id, font: Object.assign({}, n.font, { size: 0 }) })));
    await wait(400);
    r.noLabels = await drawMs();
    r.noLabelsNoBatch = hasBatch ? await (async () => { setBatch(false); const v = await drawMs(); setBatch(true); return v; })() : null;
  } catch (e) { r.noLabels = null; }
  return r;
}, SCALE);

console.log(`${path.basename(FILE)}  scale ${out.scale}  (batch: ${out.hasBatch})  visible ${out.nodes} nodes / ${out.edges} edges`);
const fmt = (v) => (v === null || v === undefined ? '   -' : String(v).padStart(5));
console.log(`  sync draw: normal ${fmt(out.normal)}   batch off ${fmt(out.noBatch)}   nodes off ${fmt(out.noNodes)}   labels off ${fmt(out.noLabels)}   labels+batch off ${fmt(out.noLabelsNoBatch)}`);
await browser.close();
srv.close();
