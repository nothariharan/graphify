// Lag hunt: drive RANDOM moves around the graph (zooms in/out, pans, at random densities)
// and find the moments where the page stutters, with the camera state and the cause.
//
//   node harness/probe_lag_hunt.mjs --file variants/base-ours-v24.html --moves 40 --out results/hunt-ours.json
//
// Instrumentation while the fuzz runs:
//   - a rAF loop: the frame gap, the camera (scale + world position), the draw counter
//   - a sampling CPU profile, correlated to the bad frames (which function was running)
//   - the visible node/edge count at the camera, for the worst moments
//
// Output: the worst moments (where, how deep, how dense, what was running) and a summary
// per kind of move, so "it lags when zoomed into a dense part" becomes a number.
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
const MOVES = Number(arg('moves', '40'));
const SEED = Number(arg('seed', '7'));
const OUT = arg('out', '');
const THRESHOLD = Number(arg('threshold', '60'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8287, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8287/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

// the recorder: frame gaps + the camera + the draw counter
await page.evaluate(() => {
  window.__frames = [];
  window.__draws = 0;
  network.on('afterDrawing', () => { window.__draws++; });
  let last = performance.now();
  const tick = (t) => {
    const v = network.getViewPosition();
    window.__frames.push({ t, gap: t - last, scale: network.getScale(), x: v.x, y: v.y, draws: window.__draws });
    last = t;
    window.__raf = requestAnimationFrame(tick);
  };
  window.__raf = requestAnimationFrame(tick);
});

// the CPU profile
const cdp = await ctx.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
const started = await cdp.send('Profiler.start');
const tMark = await page.evaluate(() => performance.now());

// ---- the fuzz ----
let seed = SEED;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const box = await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const r = cv.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
const kinds = [];
for (let i = 0; i < MOVES; i++) {
  const kind = rnd() < 0.45 ? 'zoom-in' : (rnd() < 0.5 ? 'zoom-out' : 'pan');
  kinds.push(kind);
  if (kind === 'pan') {
    // a drag: press, move in a few steps, release
    const dx = (rnd() - 0.5) * 400, dy = (rnd() - 0.5) * 300;
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    for (let s = 1; s <= 6; s++) {
      await page.mouse.move(box.x + (dx * s) / 6, box.y + (dy * s) / 6);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(40);
  } else {
    const n = 3 + Math.floor(rnd() * 8);
    const dir = kind === 'zoom-in' ? -120 : 120;
    await page.mouse.move(box.x, box.y);
    for (let s = 0; s < n; s++) {
      await page.mouse.wheel(0, dir);
      await page.waitForTimeout(30);
    }
    await page.waitForTimeout(60);
  }
}
await page.waitForTimeout(400);
const { profile } = await cdp.send('Profiler.stop');
const tEnd = await page.evaluate(() => performance.now());

// ---- correlate ----
const frames = await page.evaluate(() => window.__frames);
const byId = new Map();
for (const n of profile.nodes) byId.set(n.id, n);
const self = new Map();
const deltas = profile.timeDeltas || [];
let t = started.startTime * 1000;
const offset = tMark - t;
for (let i = 0; i < (profile.samples || []).length; i++) {
  const id = profile.samples[i];
  const dt = deltas[i] || 0;
  t += dt;
  const key = id;
  self.set(key, (self.get(key) || 0) + dt);
}
const fnOf = new Map();
for (const [id, us] of self) {
  const n = byId.get(id);
  if (!n) continue;
  const f = n.callFrame;
  const where = (f.url || '').split('/').pop().split('?')[0];
  fnOf.set(id, { us, label: (f.functionName || '(anonymous)') + (where ? ' @ ' + where : '') });
}
// the samples as a timeline, for the window lookup
let ts = started.startTime * 1000;
const sampleTimes = [];
for (let i = 0; i < (profile.samples || []).length; i++) {
  ts += deltas[i] || 0;
  // the profile's clock is monotonic-since-epoch; the page's is since navigation start
  sampleTimes.push({ t: ts - offset, id: profile.samples[i] });
}
const inWindow = (a, b) => {
  const hits = new Map();
  for (const s of sampleTimes) {
    if (s.t < a || s.t > b) continue;
    const f = fnOf.get(s.id);
    if (!f) continue;
    hits.set(f.label, (hits.get(f.label) || 0) + f.us);
  }
  return [...hits.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
};

// the density at a camera: the nodes within 260 world units of the view centre
const density = await page.evaluate((pts) => {
  const pos = network.getPositions();
  const ids = Object.keys(pos);
  return pts.map((p) => {
    let n = 0;
    const c = network.getViewPosition();
    const r = 260 / p.scale;
    for (const id of ids) {
      const q = pos[id];
      if (q && Math.abs(q.x - c.x) < r && Math.abs(q.y - c.y) < r) n++;
    }
    return n;
  });
}, frames.map((f) => ({ scale: f.scale })));

// ---- report ----
const bad = frames.map((f, i) => ({ ...f, i })).filter((f) => f.gap > THRESHOLD);
console.log(`${path.basename(FILE)}  ${MOVES} random moves (seed ${SEED}), ${frames.length} frames, ${(tEnd - tMark).toFixed(0)} ms`);
const gaps = frames.map((f) => f.gap).sort((a, b) => a - b);
const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))].toFixed(1);
console.log(`  frame gap p50 ${q(0.5)} ms  p95 ${q(0.95)} ms  p99 ${q(0.99)} ms  max ${gaps[gaps.length - 1].toFixed(1)} ms  frames over ${THRESHOLD} ms: ${bad.length}`);
if (bad.length) {
  console.log(`  the ${bad.length} worst moments (gap, scale, density, what was running):`);
  for (const f of bad.sort((a, b) => b.gap - a.gap).slice(0, 8)) {
    const d = density[f.i] === undefined ? '?' : density[f.i];
    const causes = inWindow(f.t - f.gap, f.t).map(([l, us]) => `${l} ${(us / 1000).toFixed(0)}ms`).join(', ');
    console.log(`    ${f.gap.toFixed(0).padStart(5)} ms  scale ${f.scale.toFixed(3)}  near ${d} nodes  ${causes || '(no JS - the frame was spent outside the main thread)'}`);
  }
}
// per kind of move
const byKind = {};
for (let i = 0; i < kinds.length; i++) {
  const slice = frames.filter((f) => f.i0 === undefined ? true : true);
  void slice;
}
console.log(`  the profile's hottest functions overall:`);
const agg = new Map();
for (const [id, f] of fnOf) agg.set(f.label, (agg.get(f.label) || 0) + f.us);
for (const [l, us] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    ${(us / 1000).toFixed(1).padStart(7)} ms  ${l}`);
}
if (OUT) {
  fs.writeFileSync(path.join(LAB, OUT), JSON.stringify({
    file: FILE, moves: MOVES, seed: SEED, frames: frames.length,
    gaps: { p50: +q(0.5), p95: +q(0.95), max: +gaps[gaps.length - 1].toFixed(1) },
    bad: bad.map((f) => ({ gap: f.gap, scale: f.scale, t: f.t })),
    cpu: [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  }, null, 1));
}
await browser.close();
srv.close();
