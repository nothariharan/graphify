// Screenshot a graph page at its fitted view, after physics stops.
//   node harness/shot.mjs --file variants/v8-it30.html --out shots/it30.png
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
const OUT = arg('out');

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(8241, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8241/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return typeof network !== 'undefined' && network.body && Object.keys(network.body.nodes).length > 0 && network.physics.options.enabled === false; }
  catch (e) { return false; }
}, null, { timeout: 180000 });
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(LAB, OUT) });
const info = await page.evaluate(() => {
  const ps = network.getPositions();
  const ids = Object.keys(ps);
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (const id of ids) { const p = ps[id]; minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); }
  let sum = 0, n = 0;
  for (const eid in network.body.edges) {
    const e = network.body.edges[eid];
    if (!e.from || !e.to) continue;
    sum += Math.hypot(e.from.x - e.to.x, e.from.y - e.to.y); n++;
  }
  return { nodes: ids.length, scale: +network.getScale().toFixed(5), bbox: Math.round(Math.max(maxx - minx, maxy - miny)), meanEdge: +(sum / n).toFixed(1) };
});
await browser.close(); srv.close();
console.log(JSON.stringify({ file: FILE, out: OUT, ...info }));
