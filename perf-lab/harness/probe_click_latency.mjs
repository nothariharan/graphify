// The latency of a CLICK: from the pointer down/up to the next painted frame. This is the
// interaction to next paint (INP) Chrome reports for a click, and it is where the click
// focus's work (a pass over the node colours + a full redraw) lands.
//
//   node harness/probe_click_latency.mjs --file variants/base-ours-v24.html
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const FILE = arg('file');
const CLICKS = Number(arg('clicks', '20'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8288, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8288/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

// the dense core, at a deep zoom (where the user says it lags)
const setup = await page.evaluate(() => {
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
  return { id: best, neighbours: bestN, scale: network.getScale() * 8 };
});
await page.waitForTimeout(600);

const box = await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const r = cv.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});

// click and measure the time to the next frame
const lat = [];
for (let i = 0; i < CLICKS; i++) {
  const t0 = await page.evaluate(() => performance.now());
  await page.mouse.click(box.x + (i % 5) * 7 - 14, box.y + (i % 3) * 9 - 9);
  const dt = await page.evaluate((t) => new Promise((res) => {
    requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t)));
  }), t0);
  lat.push(dt);
  await page.waitForTimeout(120);
}
lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
console.log(`${path.basename(FILE)}  ${CLICKS} clicks in the dense core at scale ${setup.scale.toFixed(3)}`);
console.log(`  click -> painted frame: p50 ${q(0.5).toFixed(1)} ms  p95 ${q(0.95).toFixed(1)} ms  max ${lat[lat.length - 1].toFixed(1)} ms`);
await browser.close();
srv.close();
