// The synchronous draw cost, not the frame interval (which is quantised to vsync - a
// "50 ms" frame is usually 3 vsyncs, not 50 ms of work).
//
//   node harness/probe_draw_sync.mjs --file variants/base-ours-v17.html
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
await new Promise((r) => srv.listen(8282, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8282/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : 0; };
  // find a synchronous redraw entry point
  const api = {
    hasCanvas: !!network.canvas,
    canvasKeys: network.canvas ? Object.keys(network.canvas).slice(0, 12) : [],
    hasRenderer: !!(network.body && network.body.renderer),
    rendererKeys: network.body && network.body.renderer ? Object.keys(network.body.renderer).slice(0, 12) : [],
  };
  let redraw = null;
  if (network.canvas && typeof network.canvas.redraw === 'function') redraw = () => network.canvas.redraw();
  else if (network.body && network.body.renderer && typeof network.body.renderer.redraw === 'function') redraw = () => network.body.renderer.redraw();
  else if (network.body && network.body.emitter) redraw = () => network.body.emitter.emit('_redraw');

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
  const centre = pos[best];
  const fit = network.getScale();
  const rows = [];
  for (const mult of [1, 2, 4, 8, 16, 24]) {
    const scale = Math.min(2.0, fit * mult);
    network.moveTo({ position: { x: centre.x, y: centre.y }, scale, animation: false });
    await wait(400);
    const samples = [];
    if (redraw) {
      for (let i = 0; i < 8; i++) {
        const t0 = performance.now();
        redraw();
        samples.push(performance.now() - t0);
      }
    }
    rows.push({ mult, scale: +scale.toFixed(3), drawMs: med(samples.slice(2)) });
  }
  return { api, rows, fit: +fit.toFixed(4) };
});

console.log(`${path.basename(FILE)}  fit ${out.fit}  canvas=${out.api.hasCanvas} renderer=${out.api.hasRenderer}`);
console.log('  canvas keys:', out.api.canvasKeys.join(', '));
console.log(`  ${"zoom".padEnd(5)} ${"scale".padEnd(7)} ${"sync draw".padStart(10)}`);
for (const r of out.rows) console.log(`  ${("x" + r.mult).padEnd(5)} ${String(r.scale).padEnd(7)} ${String(r.drawMs).padStart(10)}`);
await browser.close();
srv.close();
