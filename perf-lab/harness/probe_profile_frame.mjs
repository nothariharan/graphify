// CPU profile of a forced resting frame: the node pass costs ~63 ms of the ~86 ms frame,
// but replaying the same geometry on a canvas costs 1-3 ms, so the time is in vis's
// per-node JavaScript, not in rasterization. This profile says which functions.
//
//   node harness/probe_profile_frame.mjs --file variants/base-ours-v10.html
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
const FRAMES = Number(arg('frames', '10'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8265, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8265/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
await page.evaluate(async (frames) => {
  const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
  for (let i = 0; i < frames; i++) { network.redraw(); await tick(); }
}, FRAMES);
const { profile } = await cdp.send('Profiler.stop');

const byId = new Map();
for (const n of profile.nodes) byId.set(n.id, n);
const self = new Map();
for (const id of profile.samples || []) {
  self.set(id, (self.get(id) || 0) + 1);
}
const total = (profile.samples || []).length;
const rows = [];
for (const [id, count] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const f = n.callFrame;
  const name = (f.functionName || '(anonymous)') + ' @ ' + (f.url || '').split('/').pop() + ':' + f.lineNumber;
  rows.push({ name, count, pct: +(100 * count / total).toFixed(1) });
}
rows.sort((a, b) => b.count - a.count);
console.log(`${path.basename(FILE)}  profile samples: ${total} over ${FRAMES} forced frames`);
for (const r of rows.slice(0, 22)) console.log(`  ${String(r.pct).padStart(5)}%  ${r.name}`);
await browser.close();
srv.close();
