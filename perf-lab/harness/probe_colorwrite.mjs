// Which per-node write actually changes the drawn colour?
//  A) mutate n.options.color.background + redraw
//  B) mutate n.color.background + redraw
//  C) nodesDS.update([{id,color}]) for all nodes (timed) + redraw
// Mean brightness / red-channel share is sampled from the canvas.
//   node harness/probe_colorwrite.mjs --file view/after.html
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
await new Promise(r => srv.listen(8237, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
await page.goto('http://127.0.0.1:8237/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => typeof network !== 'undefined' && network.body && network.body.nodes && Object.keys(network.body.nodes).length > 0, null, { timeout: 180000 });
await page.waitForTimeout(1500);

const sample = () => page.evaluate(() => new Promise((res) => {
  network.once('afterDrawing', () => {
    const cv = document.querySelector('#graph canvas');
    const g = document.createElement('canvas');
    g.width = 200; g.height = 150;
    const c = g.getContext('2d');
    c.drawImage(cv, 0, 0, 200, 150);
    const d = c.getImageData(0, 0, 200, 150).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    res({ r: +(r / n).toFixed(1), g: +(gg / n).toFixed(1), b: +(b / n).toFixed(1) });
  });
  network.redraw();
}));

const base = await sample();

const a = await page.evaluate(() => {
  const nodes = network.body.nodes; let n = 0;
  for (const id in nodes) { const x = nodes[id]; if (x && x.options && x.options.color && x.options.color.background) { x.options.color.background = '#ff0000'; x.options.color.border = '#ff0000'; n++; } }
  return n;
});
const afterA = await sample();

const b = await page.evaluate(() => {
  const nodes = network.body.nodes; let n = 0;
  for (const id in nodes) { const x = nodes[id]; if (x && x.color && x.color.background) { x.color.background = '#00ff00'; x.color.border = '#00ff00'; n++; } }
  return n;
});
const afterB = await sample();

const c = await page.evaluate(() => {
  const t0 = performance.now();
  const upd = nodesDS.get().map(n => ({ id: n.id, color: { background: '#0000ff', border: '#0000ff' } }));
  const t1 = performance.now();
  nodesDS.update(upd);
  const t2 = performance.now();
  return { buildMs: +(t1 - t0).toFixed(1), updateMs: +(t2 - t1).toFixed(1), count: upd.length };
});
const afterC = await sample();

await browser.close(); srv.close();
console.log(JSON.stringify({ file: FILE, base, mutableOptions: a, afterA, mutableInstance: b, afterB, datasetUpdate: c, afterC }, null, 1));
