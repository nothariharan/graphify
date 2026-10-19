// Latency attribution for the felt-smoothness problem ("jitter while pulling").
//
// Gestures are dispatched IN-PAGE via synthetic PointerEvents, one per rAF, so the
// gesture runs at true display cadence instead of being paced by a CDP round trip
// per step (which was inflating wall time ~100ms/step and making fps meaningless).
// Verified: harness/test_synth_drag.mjs drives vis's real drag path (dragStart 1 /
// dragging N / dragEnd 1, node actually moves).
//
// Per frame we record:
//   - rAF frame deltas             -> fps / jitter (p50,p95,p99,worst,sd,jank)
//   - beforeDrawing->afterDrawing  -> vis's own draw cost per frame
// while a CDP CPU profile attributes self-time to functions / files.
//
//   node harness/profile_drag.mjs --file variants/x.html --label v30 --graph rsl
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
const LABEL = arg('label');
const GRAPH = arg('graph', 'n/a');
const STEPS = parseInt(arg('steps', '150'));
const RADIUS = parseInt(arg('radius', '150'));
const GESTURES = arg('gestures', 'pan,node').split(',').map(s => s.trim()).filter(Boolean);
const OUT_CSV = path.join(LAB, 'results', 'drag.csv');
const OUT_TXT = path.join(LAB, 'results', `drag-${LABEL}.txt`);
const VPW = 1280, VPH = 800;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };

function serve(root, port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let p = path.join(root, url);
      if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(p, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

const INSTALL = () => {
  const cv = document.querySelector('#graph canvas');
  if (!cv || typeof network === 'undefined') return { error: 'no network/canvas' };
  window.__rec = { frames: [], draws: [], dragging: 0 };
  window.__recording = false;
  window.__lastT = 0;
  window.__drawT0 = 0;
  if (!window.__installed) {
    window.__installed = true;
    network.on('beforeDrawing', () => { window.__drawT0 = performance.now(); });
    network.on('afterDrawing', () => { if (window.__recording) window.__rec.draws.push(performance.now() - window.__drawT0); });
    network.on('dragging', () => { if (window.__recording) window.__rec.dragging++; });
    (function loop(t) {
      if (window.__recording) { if (window.__lastT) window.__rec.frames.push(t - window.__lastT); }
      window.__lastT = t;
      requestAnimationFrame(loop);
    })(performance.now());
  }
  window.__arm = () => { window.__rec = { frames: [], draws: [], dragging: 0 }; window.__lastT = 0; window.__recording = true; };
  window.__disarm = () => { window.__recording = false; return window.__rec; };

  window.__pickNode = () => {
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    let best = null, bd = Infinity;
    for (const id of nodesDS.getIds()) {
      const p = network.canvasToDOM(network.getPosition(id));
      if (p.x < 60 || p.y < 60 || p.x > window.innerWidth - 60 || p.y > window.innerHeight - 60) continue;
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bd) { bd = d; best = { id, x: p.x, y: p.y }; }
    }
    return best;
  };
  window.__pickEmpty = () => {
    const pad = 26;
    for (let gy = 5; gy < 10; gy++) {
      for (let gx = 5; gx < 10; gx++) {
        const x = Math.round(window.innerWidth * gx / 10), y = Math.round(window.innerHeight * gy / 10);
        if (network.getNodeAt({ x, y })) continue;
        let ok = true;
        for (const id of nodesDS.getIds()) {
          const p = network.canvasToDOM(network.getPosition(id));
          if (Math.abs(p.x - x) < pad && Math.abs(p.y - y) < pad) { ok = false; break; }
        }
        if (ok) return { x, y };
      }
    }
    return { x: 10, y: 10 };
  };
  // Paced at one pointermove per rAF => the frame deltas ARE the felt smoothness.
  window.__runGesture = (mode, steps, radius) => new Promise((resolve) => {
    const cv2 = document.querySelector('#graph canvas');
    const pick = mode === 'node' ? window.__pickNode() : window.__pickEmpty();
    const mk = (type, x, y) => new PointerEvent(type, {
      clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0,
      buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse',
      isPrimary: true, view: window,
    });
    try { network.fit({ animation: false }); } catch (e) {}
    // two frames after fit so its own redraw is not counted in the gesture
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.__arm();
      let i = 0;
      const t0 = performance.now();
      cv2.dispatchEvent(mk('pointerdown', pick.x, pick.y));
      (function step() {
        const a = i / steps * Math.PI * 2;
        const r = radius * (0.55 + 0.45 * Math.sin(a * 3));
        cv2.dispatchEvent(mk('pointermove', pick.x + Math.cos(a) * r, pick.y + Math.sin(a) * r));
        if (++i <= steps) requestAnimationFrame(step);
        else {
          cv2.dispatchEvent(mk('pointerup', pick.x, pick.y));
          requestAnimationFrame(() => requestAnimationFrame(() => {
            resolve({ mode, target: pick, wall_ms: Math.round(performance.now() - t0), steps, rec: window.__disarm() });
          }));
        }
      })();
    }));
  });
  return { ok: true, nodes: nodesDS.length, edges: edgesDS.length };
};

const srv = await serve(LAB, 8219);
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run', '--no-default-browser-check', '--js-flags=--expose-gc'],
});
const ctx = await browser.newContext({ viewport: { width: VPW, height: VPH }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const nerrs = [];
page.on('pageerror', e => { if (nerrs.length < 6) nerrs.push(String(e.message).slice(0, 200)); });

await page.goto('http://127.0.0.1:8219/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
const install = await page.evaluate(INSTALL);
if (install.error) { console.log(JSON.stringify({ error: install.error }, null, 1)); await browser.close(); srv.close(); process.exit(1); }
await page.waitForFunction(() => {
  try { return network.physics && network.physics.options && network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1200);

function stats(d) {
  const s = d.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return { n: 0 };
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const q = p => +s[Math.min(n - 1, Math.floor(n * p))].toFixed(2);
  return {
    n,
    fps: +(1000 / (s.reduce((a, b) => a + b, 0) / n)).toFixed(1),
    p50: q(0.50), p95: q(0.95), p99: q(0.99), worst: +s[n - 1].toFixed(2),
    sd: +sd.toFixed(2),
    jank33: s.filter(x => x > 33).length, jank50: s.filter(x => x > 50).length,
  };
}

async function gesture(mode) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  await cdp.send('Profiler.start');
  const g = await page.evaluate((a) => window.__runGesture(a.mode, a.steps, a.radius), { mode, steps: STEPS, radius: RADIUS });
  const { profile } = await cdp.send('Profiler.stop');
  await cdp.send('Profiler.disable');

  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const time = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    time.set(id, (time.get(id) || 0) + (profile.timeDeltas[i] || 0));
  }
  const agg = new Map(), aggUrl = new Map();
  for (const [id, us] of time) {
    const n = byId.get(id); if (!n) continue;
    const cf = n.callFrame || {};
    const fn = (cf.functionName || '(anonymous)');
    const url = (cf.url || '').split('/').pop() || '(inline)';
    agg.set(`${fn}  [${url}:${cf.lineNumber}]`, (agg.get(`${fn}  [${url}:${cf.lineNumber}]`) || 0) + us);
    aggUrl.set(url, (aggUrl.get(url) || 0) + us);
  }
  const total = [...time.values()].reduce((a, b) => a + b, 0) || 1;
  const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([k, us]) => ({ fn: k, ms: +(us / 1000).toFixed(1), pct: +(100 * us / total).toFixed(1) }));
  const byUrl = [...aggUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, us]) => ({ url: k, ms: +(us / 1000).toFixed(1), pct: +(100 * us / total).toFixed(1) }));

  const rec = g.rec;
  const fr = stats(rec.frames);
  const dr = stats(rec.draws);
  return {
    mode, target: { id: g.target.id ?? null, x: Math.round(g.target.x), y: Math.round(g.target.y) },
    wall_ms: g.wall_ms, steps: g.steps, dragging_events: rec.dragging,
    frames: fr,
    draw_ms: { n: dr.n, p50: dr.p50, p95: dr.p95, worst: dr.worst },
    draw_share_pct: fr.n && dr.p50 ? +((dr.n * dr.p50 / fr.n / fr.p50) * 100).toFixed(0) : null,
    cpu_total_ms: +(total / 1000).toFixed(1), top, byUrl,
  };
}

const results = {};
for (const g of GESTURES) {
  results[g] = await gesture(g);
  await page.waitForTimeout(300);
}

await browser.close();
srv.close();

const L = [];
L.push(`# drag latency profile - ${LABEL} (${GRAPH})  ${new Date().toISOString().slice(0, 19)}`);
L.push(`file: ${FILE}   viewport ${VPW}x${VPH}   steps ${STEPS}   radius ${RADIUS}   (in-page, 1 pointermove per rAF)`);
for (const g of GESTURES) {
  const r = results[g];
  if (!r || r.error) { L.push(`\n## ${g}: ERROR ${r && r.error}`); continue; }
  L.push(`\n## ${g} (dragging events: ${r.dragging_events}, wall ${r.wall_ms}ms for ${r.steps} steps)`);
  L.push(`  frame deltas ms : n=${r.frames.n} fps=${r.frames.fps} p50=${r.frames.p50} p95=${r.frames.p95} p99=${r.frames.p99} worst=${r.frames.worst} sd=${r.frames.sd}`);
  L.push(`  jank            : >33ms ${r.frames.jank33}   >50ms ${r.frames.jank50}   (of ${r.frames.n})`);
  L.push(`  vis draw ms     : n=${r.draw_ms.n} p50=${r.draw_ms.p50} p95=${r.draw_ms.p95} worst=${r.draw_ms.worst}  -> ${r.draw_share_pct}% of gesture cpu-ish`);
  L.push(`  cpu total       : ${r.cpu_total_ms} ms`);
  L.push(`  by file:`); for (const u of r.byUrl) L.push(`     ${String(u.pct).padStart(5)}%  ${String(u.ms).padStart(8)}ms  ${u.url}`);
  L.push(`  top self-time:`); for (const t of r.top) L.push(`     ${String(t.pct).padStart(5)}%  ${String(t.ms).padStart(8)}ms  ${t.fn}`);
}
const txt = L.join('\n') + '\n';
fs.writeFileSync(OUT_TXT, txt);
console.log(txt);

fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
const header = 'ts,label,graph,mode,steps,wall_ms,fps,p50,p95,p99,worst,sd,jank33,jank50,draw_p50,draw_p95,draw_worst,dragging_events,cpu_ms';
if (!fs.existsSync(OUT_CSV)) fs.writeFileSync(OUT_CSV, header + '\n');
const now = new Date().toISOString().slice(0, 19);
for (const g of GESTURES) {
  const r = results[g]; if (!r || r.error) continue;
  const row = [now, LABEL, GRAPH, g, r.steps, r.wall_ms, r.frames.fps, r.frames.p50, r.frames.p95, r.frames.p99, r.frames.worst, r.frames.sd,
    r.frames.jank33, r.frames.jank50, r.draw_ms.p50, r.draw_ms.p95, r.draw_ms.worst, r.dragging_events, r.cpu_total_ms];
  fs.appendFileSync(OUT_CSV, row.join(',') + '\n');
}
if (nerrs.length) console.log('pageErrors:', JSON.stringify(nerrs));
console.log('wrote', OUT_TXT, 'and', OUT_CSV);
