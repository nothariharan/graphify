// Drift-resistant A/B: the headless machine's throughput swings ~3x between runs
// (measured: the same file gave 45.8fps and 15.2fps in different batches), so any
// sequential "before, then after" comparison is worthless. This harness runs every
// variant INSIDE every round, alternating, and reports PAIRED per-round numbers.
//
//   node harness/ab_drag.mjs --variants A=variants/base-rsl.html,C=variants/base-ours-fixed.html \
//        --rounds 3 --gestures node,pan --steps 120
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
const VARIANTS = arg('variants').split(',').map(s => { const [label, file] = s.split('='); return { label: label.trim(), file: file.trim() }; });
const ROUNDS = parseInt(arg('rounds', '3'));
const STEPS = parseInt(arg('steps', '120'));
const RADIUS = parseInt(arg('radius', '150'));
const GESTURES = arg('gestures', 'node').split(',').map(s => s.trim());
const GRAPH = arg('graph', 'rsl');
const OUT_CSV = arg('out', path.join(LAB, 'results', 'ab-drag.csv'));
// Rendering mode matters more than anything else here: Playwright's default headless
// (mode=old) rasterises canvas on the CPU, which is what made the border strokes look
// catastrophic. mode=new uses Chrome's new headless (GPU path, no window), mode=window
// is a real visible window. Compare the same variant across modes to see if the rig is
// measuring something the user never experiences.
const MODE = arg('mode', 'old');
const IS_NEW_HEADLESS = MODE === 'new';
const VPW = 1280, VPH = 800;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(8227, '127.0.0.1', r));

const INSTALL = () => {
  const cv = document.querySelector('#graph canvas');
  if (!cv || typeof network === 'undefined') return { error: 'no network/canvas' };
  window.__rec = { frames: [], draws: [], dragging: 0 };
  window.__recording = false; window.__lastT = 0; window.__drawT0 = 0;
  window.__installed = true;
  network.on('beforeDrawing', () => { window.__drawT0 = performance.now(); });
  network.on('afterDrawing', () => { if (window.__recording) window.__rec.draws.push(performance.now() - window.__drawT0); });
  network.on('dragging', () => { if (window.__recording) window.__rec.dragging++; });
  (function loop(t) { if (window.__recording) { if (window.__lastT) window.__rec.frames.push(t - window.__lastT); } window.__lastT = t; requestAnimationFrame(loop); })(performance.now());
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
    for (let gy = 5; gy < 10; gy++) for (let gx = 5; gx < 10; gx++) {
      const x = Math.round(window.innerWidth * gx / 10), y = Math.round(window.innerHeight * gy / 10);
      if (network.getNodeAt({ x, y })) continue;
      let ok = true;
      for (const id of nodesDS.getIds()) { const p = network.canvasToDOM(network.getPosition(id)); if (Math.abs(p.x - x) < pad && Math.abs(p.y - y) < pad) { ok = false; break; } }
      if (ok) return { x, y };
    }
    return { x: 10, y: 10 };
  };
  window.__runGesture = (mode, steps, radius) => new Promise((resolve) => {
    const cv2 = document.querySelector('#graph canvas');
    const pick = mode === 'node' ? window.__pickNode() : window.__pickEmpty();
    const center = { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) };
    const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window });
    const mkZoom = (x, y, dy) => new WheelEvent('wheel', { clientX: x, clientY: y, deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true, view: window });
    const start = () => {
      window.__arm();
      let i = 0; const t0 = performance.now();
      if (mode === 'zoom') {
        (function step() {
          cv2.dispatchEvent(mkZoom(center.x, center.y, Math.sin(i / steps * Math.PI * 2) * 160));
          if (++i <= steps) requestAnimationFrame(step);
          else requestAnimationFrame(() => requestAnimationFrame(() => resolve({ target: center, wall_ms: Math.round(performance.now() - t0), rec: window.__disarm() })));
        })();
        return;
      }
      cv2.dispatchEvent(mk('pointerdown', pick.x, pick.y));
      (function step() {
        const a = i / steps * Math.PI * 2, r = radius * (0.55 + 0.45 * Math.sin(a * 3));
        cv2.dispatchEvent(mk('pointermove', pick.x + Math.cos(a) * r, pick.y + Math.sin(a) * r));
        if (++i <= steps) requestAnimationFrame(step);
        else {
          cv2.dispatchEvent(mk('pointerup', pick.x, pick.y));
          requestAnimationFrame(() => requestAnimationFrame(() => resolve({ target: pick, wall_ms: Math.round(performance.now() - t0), rec: window.__disarm() })));
        }
      })();
    };
    try { network.fit({ animation: false }); } catch (e) {}
    requestAnimationFrame(() => requestAnimationFrame(start));
  });
  return { ok: true, nodes: nodesDS.length, edges: edgesDS.length };
};

const browser = await chromium.launch({
  executablePath: CHROME, headless: MODE === 'old',
  args: [...(IS_NEW_HEADLESS ? ['--headless=new'] : []),
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run', '--no-default-browser-check'],
});

// What is actually doing the drawing in this mode? Worth printing: the whole gesture
// story changes if the rig is rasterising on the CPU.
{
  const p = await browser.newPage();
  const gpu = await p.evaluate(() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return 'no webgl context';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (e) { return 'error: ' + e.message; }
  });
  await p.close();
  console.log(`# render mode: ${MODE}   gpu: ${gpu}`);
}

function stats(d) {
  const s = d.slice().sort((a, b) => a - b); const n = s.length;
  if (!n) return { n: 0 };
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const q = p => +s[Math.min(n - 1, Math.floor(n * p))].toFixed(2);
  return { n, fps: +(1000 / mean).toFixed(1), p50: q(0.5), p95: q(0.95), worst: +s[n - 1].toFixed(2) };
}

const samples = [];
for (let round = 1; round <= ROUNDS; round++) {
  for (const v of VARIANTS) {
    const ctx = await browser.newContext({ viewport: { width: VPW, height: VPH }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const url = 'http://127.0.0.1:8227/' + v.file.replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'load', timeout: 180000 });
    // Only the cached-layout builds need a storage clear + reload; a huge baseline
    // without the cache would pay a second 11MB load for nothing.
    const hasCache = fs.readFileSync(path.join(LAB, v.file), 'utf8').includes('_savePositions');
    if (hasCache) {
      await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
      await page.reload({ waitUntil: 'load', timeout: 180000 });
    }
    const ins = await page.evaluate(INSTALL);
    if (ins.error) { console.log('install error', v.label, ins.error); await ctx.close(); continue; }
    await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(800);
    for (const mode of GESTURES) {
      const g = await page.evaluate((a) => window.__runGesture(a.mode, a.steps, a.radius), { mode, steps: STEPS, radius: RADIUS });
      const fr = stats(g.rec.frames), dr = stats(g.rec.draws);
      samples.push({ round, label: v.label, mode, steps: STEPS, fps: fr.fps, p50: fr.p50, p95: fr.p95, worst: fr.worst, jank33: g.rec.frames.filter(x => x > 33).length, draw_p50: dr.p50, draw_p95: dr.p95, wall_ms: g.wall_ms, dragging: g.rec.dragging });
      await page.waitForTimeout(250);
    }
    await ctx.close();
  }
}
await browser.close();
srv.close();

// CSV
const cols = Object.keys(samples[0]);
fs.mkdirSync(path.dirname(OUT_CSV), { recursive: true });
fs.writeFileSync(OUT_CSV, cols.join(',') + '\n' + samples.map(s => cols.map(c => s[c]).join(',')).join('\n') + '\n');

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
console.log(`# interleaved A/B drag - ${GRAPH}, ${ROUNDS} rounds, ${STEPS} steps/gesture (in-page, 1 move per rAF) [render mode: ${MODE}]`);
console.log(`# per-round fps by variant (drift is visible when a round's numbers all move together)\n`);
for (const mode of GESTURES) {
  console.log(`## gesture: ${mode}`);
  const labels = VARIANTS.map(v => v.label);
  console.log('  round  ' + labels.map(l => l.padStart(14)).join(''));
  for (let r = 1; r <= ROUNDS; r++) {
    const row = labels.map(l => { const s = samples.find(x => x.round === r && x.label === l && x.mode === mode); return (s ? String(s.fps) : '-').padStart(14); });
    console.log(`  ${String(r).padStart(5)}  ` + row.join(''));
  }
  const meds = labels.map(l => med(samples.filter(x => x.label === l && x.mode === mode).map(x => x.fps)));
  const base = meds[0];
  console.log('  median ' + meds.map((m, i) => (m.toFixed(1) + (i ? ` (x${(m / base).toFixed(2)})` : ' (ref)')).padStart(14)).join(''));
  const d50 = labels.map(l => med(samples.filter(x => x.label === l && x.mode === mode).map(x => x.draw_p50)));
  const dw = labels.map(l => med(samples.filter(x => x.label === l && x.mode === mode).map(x => x.draw_p95)));
  console.log('  draw p50 ' + d50.map(m => String(m).padStart(14)).join(''));
  console.log('  draw p95 ' + dw.map(m => String(m).padStart(14)).join(''));
  const jk = labels.map(l => med(samples.filter(x => x.label === l && x.mode === mode).map(x => x.jank33)));
  console.log('  jank>33  ' + jk.map(m => String(m).padStart(14)).join(''));
  console.log();
}
console.log('wrote', OUT_CSV);
