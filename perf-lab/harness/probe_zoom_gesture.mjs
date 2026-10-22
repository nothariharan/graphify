// A real wheel gesture from a deep starting zoom: frame gaps, stalls and how far it gets.
//
//   node harness/probe_zoom_gesture.mjs --file variants/base-ours-v20.html
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
const STEPS = Number(arg('steps', '14'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8283, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8283/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const start = await page.evaluate(() => {
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
  const c = pos[best];
  const fit = network.getScale();
  network.moveTo({ position: { x: c.x, y: c.y }, scale: fit * 8, animation: false });
  // gap recorder
  window.__gaps = [];
  let last = performance.now();
  const tick = (t) => { window.__gaps.push(t - last); last = t; window.__raf = requestAnimationFrame(tick); };
  window.__raf = requestAnimationFrame(tick);
  return { fit: +fit.toFixed(4), start: +(fit * 8).toFixed(4) };
});
await page.waitForTimeout(600);

const box = await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const r = cv.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
await page.mouse.move(box.x, box.y);

const t0 = Date.now();
for (let i = 0; i < STEPS; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(45);
}
await page.waitForTimeout(600);
const total = Date.now() - t0;

const out = await page.evaluate(() => {
  const g = window.__gaps.slice(2).sort((a, b) => b - a);
  const n = g.length;
  return {
    endScale: +network.getScale().toFixed(4),
    max: Math.round(g[0] || 0),
    p95: Math.round(g[Math.floor(n * 0.05)] || 0),
    p50: Math.round(g[Math.floor(n / 2)] || 0),
    stalls: g.filter((x) => x > 33).length,
    frames: n,
  };
});

console.log(`${path.basename(FILE)}  fit ${start.fit} -> deep ${start.start}  (${STEPS} wheel steps, ${total} ms)`);
console.log(`  final scale ${out.endScale}   frames ${out.frames}   p50 ${out.p50} ms   p95 ${out.p95}   max ${out.max}   stalls>33 ${out.stalls}`);
await browser.close();
srv.close();
