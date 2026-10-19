// Count distinct (fill colour, radius) pairs among the rendered nodes, plus a
// per-frame canvas-op tally during a drag. Run:
//   node harness/probe_nodes.mjs --file view/after.html
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
const FILE = arg('file', 'view/after.html');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise(r => srv.listen(8240, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.addInitScript(() => {
  const orig = { arc: CanvasRenderingContext2D.prototype.arc, fill: CanvasRenderingContext2D.prototype.fill, stroke: CanvasRenderingContext2D.prototype.stroke, beginPath: CanvasRenderingContext2D.prototype.beginPath };
  window.__ops = { arc: 0, fill: 0, stroke: 0, beginPath: 0 };
  window.__pairs = new Map();
  CanvasRenderingContext2D.prototype.beginPath = function () { window.__ops.beginPath++; return orig.beginPath.apply(this, arguments); };
  CanvasRenderingContext2D.prototype.arc = function (x, y, r) {
    const key = (this.fillStyle || '') + '|' + r;
    window.__pairs.set(key, (window.__pairs.get(key) || 0) + 1);
    window.__ops.arc++;
    return orig.arc.apply(this, arguments);
  };
  CanvasRenderingContext2D.prototype.fill = function () { window.__ops.fill++; return orig.fill.apply(this, arguments); };
  CanvasRenderingContext2D.prototype.stroke = function () { window.__ops.stroke++; return orig.stroke.apply(this, arguments); };
});

await page.goto('http://127.0.0.1:8240/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });

for (let i = 0; i < 60; i++) {
  const off = await page.evaluate(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } });
  if (off) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1000);

const model = await page.evaluate(() => {
  const nodes = network.body.nodes;
  const pairs = new Map();
  let n = 0;
  for (const id in nodes) {
    n++;
    const nd = nodes[id];
    const opts = nd.options || {};
    const col = (opts.color && (typeof opts.color === 'string' ? opts.color : (opts.color.background || opts.color))) || '?';
    const r = (typeof opts.size === 'number') ? opts.size : (nd.radius || '?');
    const key = col + '|' + r;
    pairs.set(key, (pairs.get(key) || 0) + 1);
  }
  return { n, distinct: pairs.size, pairs: Array.from(pairs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 25) };
});
console.log('MODEL nodes:', model.n, 'distinct (colour,radius) pairs:', model.distinct);
console.log('top pairs (colour|radius -> count):');
for (const [k, v] of model.pairs) console.log('  ' + v.toString().padStart(5) + '  ' + k);

await page.evaluate(() => { window.__ops = { arc: 0, fill: 0, stroke: 0, beginPath: 0 }; window.__pairs = new Map(); });

const cv = await page.$('#graph canvas');
const box = await cv.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
for (let i = 0; i < 20; i++) {
  await page.mouse.move(box.x + box.width / 2 + i * 4, box.y + box.height / 2 + i * 3, { steps: 1 });
}
await page.mouse.up();
await page.waitForTimeout(200);

const ops = await page.evaluate(() => window.__ops);
const pairs = await page.evaluate(() => Array.from(window.__pairs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20));
console.log('\nPER-FRAME OPS (during drag):', JSON.stringify(ops));
console.log('distinct (fillStyle|radius) combos seen in arc calls:', pairs.length);
for (const [k, v] of pairs) console.log('  ' + v.toString().padStart(5) + '  ' + k);

await browser.close();
srv.close();