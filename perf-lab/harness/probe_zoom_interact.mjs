// What does the user actually pay when they sit in the dense centre and move the mouse or
// the wheel? The plain redraw was 17-28 ms in probe_zoom_split; this measures the two
// interaction paths on top of it.
//
//   node harness/probe_zoom_interact.mjs --file variants/base-ours-v16.html
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
await new Promise((r) => srv.listen(8281, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8281/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const one = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : 0; };

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

  // gap recorder
  let gaps = [], running = false;
  const tick = (t) => { gaps.push(t - (window.__lastT || t)); window.__lastT = t; if (running) window.__raf = requestAnimationFrame(tick); };
  const startGaps = () => { gaps = []; window.__lastT = performance.now(); running = true; window.__raf = requestAnimationFrame(tick); };
  const stopGaps = () => { running = false; if (window.__raf) cancelAnimationFrame(window.__raf); const g = gaps.slice(1).sort((a, b) => b - a); return { max: Math.round(g[0] || 0), p50: Math.round(g[Math.floor(g.length / 2)] || 0) }; };

  for (const mult of [16, 8, 4, 1]) {
    const scale = Math.min(2.0, fit * mult);
    network.moveTo({ position: { x: centre.x, y: centre.y }, scale, animation: false });
    await wait(500);
    const visible = ids.filter((id) => {
      const p = pos[id];
      if (!p) return false;
      const cv = document.querySelector('#graph canvas');
      const sx = cv.width / 2 + (p.x - network.getViewPosition().x) * scale;
      const sy = cv.height / 2 + (p.y - network.getViewPosition().y) * scale;
      return sx > 0 && sy > 0 && sx < cv.width && sy < cv.height;
    });

    // 1. plain redraws, one per frame
    const frames = [];
    let last = await one();
    for (let i = 0; i < 12; i++) { network.redraw(); const t = await one(); frames.push(t - last); last = t; }

    // 2. hover sweep: a different node every 120 ms, 16 nodes
    startGaps();
    for (let i = 0; i < 16; i++) {
      network.emit('hoverNode', { node: visible[i % Math.max(1, visible.length)] });
      await wait(120);
    }
    network.emit('blurNode', { node: visible[0] });
    await wait(200);
    const hoverGaps = stopGaps();

    rows.push({ mult, scale: +scale.toFixed(3), visible: visible.length, frameP50: med(frames.slice(1)), hoverMax: hoverGaps.max, hoverP50: hoverGaps.p50 });
  }
  return { rows, fit: +fit.toFixed(4) };
});

console.log(`${path.basename(FILE)}  fit ${out.fit}`);
console.log(`  ${"zoom".padEnd(5)} ${"scale".padEnd(7)} ${"visible".padStart(8)} ${"redraw p50".padStart(11)} ${"hover gap p50".padStart(14)} ${"hover gap max".padStart(14)}`);
for (const r of out.rows) {
  console.log(`  ${("x" + r.mult).padEnd(5)} ${String(r.scale).padEnd(7)} ${String(r.visible).padStart(8)} ${String(r.frameP50).padStart(11)} ${String(r.hoverP50).padStart(14)} ${String(r.hoverMax).padStart(14)}`);
}
await browser.close();
srv.close();
