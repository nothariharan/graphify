// Does writing node instance `options.opacity` (no DataSet update) change the drawing?
// Samples the canvas mean brightness before/after a direct mutation + redraw.
//   node harness/probe_opacity.mjs --file view/after.html
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
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(8236, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
await page.goto('http://127.0.0.1:8236/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => typeof network !== 'undefined' && network.body && network.body.nodes && Object.keys(network.body.nodes).length > 0, null, { timeout: 180000 });
await page.waitForTimeout(1500);

const brightness = () => page.evaluate(() => new Promise((res) => {
  network.once('afterDrawing', () => {
    const cv = document.querySelector('#graph canvas');
    const g = document.createElement('canvas');
    g.width = 200; g.height = 150;
    const c = g.getContext('2d');
    c.drawImage(cv, 0, 0, 200, 150);
    const d = c.getImageData(0, 0, 200, 150).data;
    let sum = 0, n = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += v; n++; if (v > 20) lit++; }
    res({ mean: +(sum / n).toFixed(2), litPx: lit });
  });
  network.redraw();
}));

const before = await brightness();
const mutate = await page.evaluate(() => {
  const nodes = network.body.nodes;
  let n = 0;
  for (const id in nodes) { const x = nodes[id]; if (x && x.options) { x.options.opacity = 0.3; n++; } }
  return n;
});
await page.waitForTimeout(50);
const after = await brightness();

const viaSetOptions = await page.evaluate(() => {
  const nodes = network.body.nodes;
  let n = 0;
  for (const id in nodes) { const x = nodes[id]; if (x && x.setOptions) { x.setOptions({ opacity: 0.9 }); n++; } }
  return n;
});
await page.waitForTimeout(50);
const afterSet = await brightness();

await browser.close(); srv.close();
console.log(JSON.stringify({ file: FILE, mutated: mutate, viaSetOptions, before, after, afterSet }, null, 1));
