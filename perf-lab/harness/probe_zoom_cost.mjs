// Where does a lean draw at deep zoom spend its time? Times redraws with the batch on,
// then with node labels / nodes / edges switched off by mutating instance options.
//   node harness/probe_zoom_cost.mjs --file variants/v8-obsidian.html --scale 0.57
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
const SCALE = parseFloat(arg('scale', '0.57'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(8239, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
await page.goto('http://127.0.0.1:8239/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => typeof network !== 'undefined' && network.body && Object.keys(network.body.nodes).length > 0, null, { timeout: 180000 });
await page.waitForTimeout(1200);

const time = (runs = 12) => page.evaluate(({ scale, runs }) => {
  function lean(on) { try { _setLean(on, false); } catch (e) {} }
  lean(true);
  network.moveTo({ scale, animation: false });
  network.redraw();
  const ds = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    network.redraw();
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  return { p50: +ds[Math.floor(ds.length / 2)].toFixed(1), min: +ds[0].toFixed(1), max: +ds[ds.length - 1].toFixed(1) };
}, { scale: SCALE, runs });

const out = {};
out.lean_baseline = await time();

await page.evaluate(() => {
  const nodes = network.body.nodes;
  for (const id in nodes) { const n = nodes[id]; if (n && n.options && n.options.font) n.options.font.size = 0; }
});
out.lean_noLabels = await time();

await page.evaluate(() => {
  const nodes = network.body.nodes;
  for (const id in nodes) { const n = nodes[id]; if (n && n.options) n.options.shape = 'image'; }
});
out.lean_noNodes = await time();

await page.evaluate(() => { try { _setLean(false, false); } catch (e) {} });
out.full_baseline = await time();

await browser.close();
srv.close();
console.log(JSON.stringify({ file: FILE, scale: SCALE, ...out }, null, 1));
