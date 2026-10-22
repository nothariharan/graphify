// Trace: during one wheel gesture, how many redraws does each build do, and how long does
// the JavaScript between the wheel and the paint take?
//
//   node harness/probe_gesture_work.mjs --file variants/base-official-v8.html
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
const NOSYNC = arg('nosync', '0') === '1';

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8285, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8285/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

await page.evaluate((nosync) => {
  if (nosync) { try { window._syncArrows = function () {}; } catch (e) {} }
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
  network.moveTo({ position: { x: c.x, y: c.y }, scale: network.getScale() * 8, animation: false });
  // counters
  window.__w = { draws: 0, wheels: 0, raf: 0, handlerMs: 0 };
  network.on('afterDrawing', () => { window.__w.draws++; });
  window.addEventListener('wheel', (e) => {
    const t0 = performance.now();
    // capture the handler's own cost: run after the page's handlers have queued their work
    window.__w.wheels++;
    requestAnimationFrame(() => { window.__w.handlerMs += performance.now() - t0; });
  }, true);
}, NOSYNC);
await page.waitForTimeout(500);

const box = await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const r = cv.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
await page.mouse.move(box.x, box.y);

for (let i = 0; i < STEPS; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(45);
}
await page.waitForTimeout(700);

const out = await page.evaluate(() => {
  const w = window.__w;
  return { ...w, scale: +network.getScale().toFixed(3) };
});
console.log(`${path.basename(FILE)}  scale now ${out.scale}`);
console.log(`  wheel events ${out.wheels}   redraws ${out.draws}   redraws per event ${(out.draws / Math.max(1, out.wheels)).toFixed(2)}   wheel->frame work ${Math.round(out.handlerMs)} ms total (${(out.handlerMs / Math.max(1, out.wheels)).toFixed(1)} ms per event)`);
await browser.close();
srv.close();
