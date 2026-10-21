// Is the node pass slow because of vis's JavaScript, or because drawing on the *visible*
// canvas is expensive (state changes, presentation) while the same draw on an offscreen
// canvas is cheap?
//
//   node harness/probe_node_canvas.mjs --file variants/base-ours-v10.html
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
await new Promise((r) => srv.listen(8267, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8267/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const vis = document.querySelector('#graph canvas');
  const vctx = vis.getContext('2d');
  const W = vis.width, H = vis.height;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d');

  const nodes = [];
  for (const id in network.body.nodes) {
    const n = network.body.nodes[id];
    if (!n || n.x === undefined) continue;
    const t = n.getFormattingValues ? n.getFormattingValues() : {};
    nodes.push({ x: n.x, y: n.y, r: (t.size || 10) / 2, col: (n.options.color && n.options.color.background) || '#888' });
  }
  const byKey = new Map();
  for (const n of nodes) {
    const k = n.col + '|' + Math.round(n.r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(n);
  }

  const run = (ctx, fn, flush, n) => {
    const s = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      fn(ctx);
      flush(ctx);
      s.push(performance.now() - t0);
    }
    return +med(s).toFixed(1);
  };
  const perNode = (ctx) => {
    for (const n of nodes) {
      ctx.beginPath();
      ctx.moveTo(n.x + n.r, n.y);
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.col;
      ctx.fill();
    }
  };
  const grouped = (ctx) => {
    for (const [, list] of byKey) {
      ctx.beginPath();
      for (const n of list) { ctx.moveTo(n.x + n.r, n.y); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); }
      ctx.fillStyle = list[0].col;
      ctx.fill();
    }
  };
  const flushRead = (ctx) => ctx.getImageData(0, 0, 1, 1);

  return {
    canvas: W + 'x' + H, nodes: nodes.length, groups: byKey.size,
    offPerNode: run(octx, perNode, flushRead, 8),
    offGrouped: run(octx, grouped, flushRead, 8),
    visPerNode: run(vctx, perNode, flushRead, 8),
    visGrouped: run(vctx, grouped, flushRead, 8),
  };
});

console.log(`${path.basename(FILE)}  canvas ${out.canvas}, ${out.nodes} nodes, ${out.groups} groups`);
console.log(`  offscreen, per node   ${out.offPerNode} ms`);
console.log(`  offscreen, grouped    ${out.offGrouped} ms`);
console.log(`  VISIBLE, per node     ${out.visPerNode} ms`);
console.log(`  VISIBLE, grouped      ${out.visGrouped} ms`);
await browser.close();
srv.close();
