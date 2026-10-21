// What does the node pass actually cost, and how much of it is raster vs vis's own JS?
//
//   node harness/probe_node_cost.mjs --file variants/base-ours-v10.html
//
// 1. measure the shipped frame (forced redraw, median)
// 2. replay the same geometry on an offscreen canvas the cheapest way possible
//    (one path with 1886 arcs, one fill, one stroke) - the floor for any batched node pass
// 3. replay it per node (1886 beginPath/arc/fill/stroke) - what vis does today
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
await new Promise((r) => srv.listen(8264, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8264/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

  // shipped frame
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const t0 = performance.now();
    network.redraw();
    await tick();
    samples.push(performance.now() - t0);
  }
  const shipped = med(samples.slice(1));

  // the node geometry as vis sees it
  const nodes = [];
  for (const id in network.body.nodes) {
    const n = network.body.nodes[id];
    if (!n || !n.x === undefined) continue;
    const t = n.getFormattingValues ? n.getFormattingValues() : {};
    nodes.push({
      x: n.x, y: n.y,
      r: (t.size || 10) / 2,
      col: (n.options.color && n.options.color.background) || '#888',
      bw: n.options.borderWidth === undefined ? 1.5 : n.options.borderWidth,
    });
  }

  const W = 1000, H = 800;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const c = off.getContext('2d');

  const run = (fn, n) => {
    const s = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      fn();
      s.push(performance.now() - t0);
    }
    return +med(s).toFixed(1);
  };

  // one path, one fill, one stroke (the batched floor)
  const grouped = run(() => {
    c.clearRect(0, 0, W, H);
    c.beginPath();
    for (const n of nodes) { c.moveTo(n.x + n.r, n.y); c.arc(n.x, n.y, n.r, 0, Math.PI * 2); }
    c.fillStyle = '#888';
    c.fill();
    c.lineWidth = 1.5;
    c.strokeStyle = '#888';
    c.stroke();
  }, 10);

  // per node, like vis does it
  const perNode = run(() => {
    c.clearRect(0, 0, W, H);
    for (const n of nodes) {
      c.beginPath();
      c.moveTo(n.x + n.r, n.y);
      c.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      c.fillStyle = n.col;
      c.fill();
      c.lineWidth = n.bw;
      c.strokeStyle = n.col;
      c.stroke();
    }
  }, 10);

  // 208 groups (colour x radius), one path each: the realistic batched pass
  const byKey = new Map();
  for (const n of nodes) {
    const k = n.col + '|' + Math.round(n.r) + '|' + n.bw;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(n);
  }
  const grouped208 = run(() => {
    c.clearRect(0, 0, W, H);
    for (const [, list] of byKey) {
      c.beginPath();
      for (const n of list) { c.moveTo(n.x + n.r, n.y); c.arc(n.x, n.y, n.r, 0, Math.PI * 2); }
      c.fillStyle = list[0].col;
      c.fill();
      c.lineWidth = list[0].bw;
      c.strokeStyle = list[0].col;
      c.stroke();
    }
  }, 10);

  return {
    shippedFrame: +shipped.toFixed(1), nodes: nodes.length, groups: byKey.size,
    groupedOnePath: grouped, perNode: perNode, grouped208,
  };
});

console.log(`${path.basename(FILE)}`);
console.log(`  shipped frame            ${out.shippedFrame} ms`);
console.log(`  replay, one path        ${out.groupedOnePath} ms  (${out.nodes} arcs, 1 fill, 1 stroke)`);
console.log(`  replay, ${String(out.groups).padStart(3)} groups       ${out.grouped208} ms  (${out.nodes} arcs, ${out.groups} fills, ${out.groups} strokes)`);
console.log(`  replay, per node        ${out.perNode} ms  (${out.nodes} x beginPath/arc/fill/stroke)`);
await browser.close();
srv.close();
