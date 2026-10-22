// Trace a real zoom gesture in a dense area and attribute the cost.
//
//   node harness/probe_zoom_trace.mjs --file variants/base-ours-v23.html
//
// Two instruments, run together over the same gesture:
//   1. a sampling CPU profile -> the top JavaScript functions by self time
//   2. the devtools.timeline trace -> per frame: script, style/layout, paint, raster,
//      plus the wheel-event -> next-paint latency (the INP the browser reports)
//
// The output is the "where does the lag come from" table, per build, so two builds can be
// compared line by line.
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
const DEEP = arg('deep', '1') === '1';
const OUT = arg('out', '');

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8286, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8286/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

// the dense core
const cam = await page.evaluate((deep) => {
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
  network.moveTo({ position: { x: c.x, y: c.y }, scale: network.getScale() * (deep ? 8 : 1), animation: false });
  // who asks for each redraw? the stack of the draw call is the answer
  window.__stacks = new Map();
  network.on('afterDrawing', () => {
    const lines = (new Error().stack || '').split('\n').slice(1, 14)
      .map((l) => l.trim().replace(/https?:\/\/[^ )]+[/:]/, '').replace(/^at /, '').trim());
    const st = lines.join(' | ');
    window.__stacks.set(st, (window.__stacks.get(st) || 0) + 1);
  });
  return { x: c.x, y: c.y, scale: network.getScale() * (deep ? 8 : 1) };
}, DEEP);
await page.waitForTimeout(600);

const box = await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const r = cv.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(200);

// ---- instruments on ----
const cdp = await ctx.newCDPSession(page);
const events = [];
cdp.on('Tracing.dataCollected', (p) => { for (const e of p.value) events.push(e); });
await cdp.send('Tracing.start', {
  traceConfig: {
    includedCategories: [
      'devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.timeline', 'latencyInfo', 'benchmark',
    ],
    recordMode: 'recordAsMuchAsPossible',
  },
  transferMode: 'ReportEvents',
});
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');

const t0 = Date.now();
for (let i = 0; i < STEPS; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(45);
}
await page.waitForTimeout(500);
const wall = Date.now() - t0;

const { profile } = await cdp.send('Profiler.stop');
await cdp.send('Tracing.end');
await page.waitForTimeout(600);

// ---- 1. the CPU profile: self time per function ----
const byId = new Map();
for (const n of profile.nodes) byId.set(n.id, n);
const self = new Map();
const deltas = profile.timeDeltas || [];
for (let i = 0; i < (profile.samples || []).length; i++) {
  const id = profile.samples[i];
  const dt = deltas[i] || 0;
  self.set(id, (self.get(id) || 0) + dt);
}
const rows = [];
for (const [id, us] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const f = n.callFrame;
  const where = (f.url || '').split('/').pop().split('?')[0];
  const label = (f.functionName || '(anonymous)') + (where && where !== '' ? ' @ ' + where : '');
  rows.push({ label, ms: us / 1000 });
}
const merged = new Map();
for (const r of rows) merged.set(r.label, (merged.get(r.label) || 0) + r.ms);
const top = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
const totalCpu = [...merged.values()].reduce((a, b) => a + b, 0);

// ---- 2. the timeline: frames, phases, and the wheel -> paint latency ----
const ph = { script: 0, style: 0, layout: 0, paint: 0, raster: 0, other: 0 };
const name = (e) => e.name;
const inFrame = new Map();
for (const e of events) {
  const dur = e.dur || 0;
  if (e.ph === 'X') {
    if (name(e) === 'UpdateLayoutTree' || name(e) === 'ParseAuthorStyleSheet') ph.style += dur;
    else if (name(e) === 'Layout') ph.layout += dur;
    else if (name(e) === 'Paint' || name(e) === 'PaintImage' || name(e) === 'CompositeLayers') ph.paint += dur;
    else if (name(e) === 'RasterTask' || name(e) === 'Rasterize' || name(e) === 'ImageDecodeTask') ph.raster += dur;
    else if (name(e) === 'FunctionCall' || name(e) === 'RunTask' || name(e) === 'v8.run' || name(e) === 'TimerFire' || name(e) === 'EventDispatch') ph.script += dur;
    else ph.other += dur;
  }
}
const wheels = events.filter((e) => e.name === 'EventDispatch' && e.args && e.args.data && e.args.data.type === 'wheel');
const paints = events.filter((e) => (e.name === 'Paint' || e.name === 'DrawFrame') && e.ph === 'X');
// the paint that follows each wheel
const lat = [];
for (const w of wheels) {
  const p = paints.find((q) => q.ts > w.ts);
  if (p) lat.push((p.ts - w.ts) / 1000);
}
lat.sort((a, b) => a - b);
const q = (arr, p) => (arr.length ? +arr[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(1) : 0);
const frames = events.filter((e) => e.name === 'DrawFrame' && e.ph === 'X' && e.dur);

console.log(`${path.basename(FILE)}  ${STEPS} wheel notches in the dense core (from scale ${cam.scale.toFixed(3)}), ${wall} ms wall`);
console.log(`  timeline (ms): script ${(ph.script / 1000).toFixed(1)}  style ${(ph.style / 1000).toFixed(1)}  layout ${(ph.layout / 1000).toFixed(1)}  paint ${(ph.paint / 1000).toFixed(1)}  raster ${(ph.raster / 1000).toFixed(1)}  other ${(ph.other / 1000).toFixed(1)}`);
console.log(`  frames drawn ${frames.length}  median frame ${q(frames.map((f) => f.dur / 1000), 0.5)} ms  p95 ${q(frames.map((f) => f.dur / 1000), 0.95)} ms`);
console.log(`  wheel -> next paint: p50 ${q(lat, 0.5)} ms  p95 ${q(lat, 0.95)} ms  max ${lat.length ? lat[lat.length - 1].toFixed(1) : 0} ms  (n=${lat.length})`);
console.log(`  CPU ${totalCpu.toFixed(1)} ms, top functions:`);
for (const [label, ms] of top) console.log(`    ${ms.toFixed(1).padStart(7)} ms  ${label}`);

const stacks = await page.evaluate(() => [...window.__stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
console.log(`  who asked for the ${[...stacks].reduce((a, b) => a + b[1], 0)} redraws:`);
for (const [st, n] of stacks) console.log(`    ${String(n).padStart(4)}x  ${st}`);

if (OUT) {
  fs.writeFileSync(path.join(LAB, OUT), JSON.stringify({ file: FILE, wall, phases: ph, frames: frames.length, lat, cpu: top, stacks }, null, 1));
}
await browser.close();
srv.close();
