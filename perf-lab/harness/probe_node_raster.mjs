// How much of the node pass is rasterization, and would batching the dots actually pay?
//
// The first replay measured only the *recording* of the canvas ops (1-3 ms); the real
// cost shows up when the canvas is rasterized. This version forces a flush (getImageData)
// after every draw, so the number is the true cost of putting 1886 anti-aliased,
// bordered circles on a 1000x800 surface.
//
//   node harness/probe_node_raster.mjs --file variants/base-ours-v10.html
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
await new Promise((r) => srv.listen(8266, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8266/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const W = 1000, H = 800;
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const c = off.getContext('2d');
  const flush = () => c.getImageData(0, 0, 1, 1);

  const nodes = [];
  for (const id in network.body.nodes) {
    const n = network.body.nodes[id];
    if (!n || n.x === undefined) continue;
    const t = n.getFormattingValues ? n.getFormattingValues() : {};
    nodes.push({
      x: n.x, y: n.y, r: (t.size || 10) / 2,
      col: (n.options.color && n.options.color.background) || '#888',
      bw: n.options.borderWidth === undefined ? 1.5 : n.options.borderWidth,
    });
  }
  const byKey = new Map();
  for (const n of nodes) {
    const k = n.col + '|' + Math.round(n.r) + '|' + n.bw;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(n);
  }

  const run = (fn, n) => {
    const s = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      fn();
      flush();
      s.push(performance.now() - t0);
    }
    return +med(s).toFixed(1);
  };

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
  }, 8);

  const grouped = run(() => {
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
  }, 8);

  const perNodeNoBorder = run(() => {
    c.clearRect(0, 0, W, H);
    for (const n of nodes) {
      c.beginPath();
      c.moveTo(n.x + n.r, n.y);
      c.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      c.fillStyle = n.col;
      c.fill();
    }
  }, 8);

  const empty = run(() => { c.clearRect(0, 0, W, H); }, 8);
  return { nodes: nodes.length, groups: byKey.size, perNode, grouped, perNodeNoBorder, empty };
});

console.log(`${path.basename(FILE)}  ${out.nodes} nodes, ${out.groups} (colour,radius,border) groups`);
console.log(`  empty canvas            ${out.empty} ms`);
console.log(`  per node (vis style)    ${out.perNode} ms`);
console.log(`  per node, no border     ${out.perNodeNoBorder} ms`);
console.log(`  grouped paths           ${out.grouped} ms`);
await browser.close();
srv.close();
