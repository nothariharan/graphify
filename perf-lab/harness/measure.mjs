// Graphify perf-lab measurement harness.
// Deterministic: launches its own headless Chrome (never occluded/throttled),
// serves the lab over http (vis-network localized, so CDN latency is excluded),
// runs a fixed battery, and appends one CSV row per (variant, graph, dpr).
//
// Usage:
//   node harness/measure.mjs --file variants/x.html --label baseline --lane L0 \
//        --graph rsl --nodes 1886 --edges 3876 --dpr 1 --runs 15
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const FILE = arg('file');
const LABEL = arg('label');
const LANE = arg('lane', 'L0');
const GRAPH = arg('graph', 'n/a');
const NODES = arg('nodes', '');
const EDGES = arg('edges', '');
const DPR = parseFloat(arg('dpr', '1'));
const RUNS = parseInt(arg('runs', '15'));
const CSV = arg('csv', path.join(LAB, 'results', 'results.csv'));
const VPW = parseInt(arg('vw', '1280'));
const VPH = parseInt(arg('vh', '800'));

if (!FILE || !LABEL) { console.error('need --file and --label'); process.exit(2); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };

function serve(root, port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      let p = path.join(root, url);
      if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
      fs.readFile(p, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

const BATTERY = async (cfg) => {
  const nav = performance.getEntriesByType('navigation')[0];
  const cv = document.querySelector('#graph canvas');
  if (!cv) return { error: 'no canvas' };
  const rect = cv.getBoundingClientRect();
  const cx = Math.round(rect.left + rect.width / 2), cy = Math.round(rect.top + rect.height / 2);
  const out = {};
  out.dcl_ms = Math.round(nav.domContentLoadedEventEnd);
  out.load_ms = Math.round(nav.loadEventEnd);
  out.nodes = nodesDS.length;
  out.edges = edgesDS.length;
  out.labels = RAW_NODES.filter(n => n.font && n.font.size > 0).length;
  out.arrows = edgesDS.get().filter(e => e.arrows && e.arrows.to && e.arrows.to.enabled).length;
  out.dashed = RAW_EDGES.filter(e => e.dashes).length;
  out.communities = new Set(RAW_NODES.map(n => n.community)).size;
  out.canvas_w = cv.width; out.canvas_h = cv.height;
  out.canvas_px = cv.width * cv.height;
  out.dpr = window.devicePixelRatio;

  const tr = () => new Promise(res => { const t0 = performance.now(); network.once('afterDrawing', () => res(performance.now() - t0)); network.redraw(); });
  const red = [];
  for (let i = 0; i < cfg.runs; i++) red.push(await tr());
  const rs = red.slice(1).sort((a, b) => a - b);
  out.redraw_med = +rs[Math.floor(rs.length / 2)].toFixed(1);
  out.redraw_p95 = +rs[Math.floor(rs.length * 0.95)].toFixed(1);
  out.redraw_min = +rs[0].toFixed(1);

  const longtasks = [];
  let po = null;
  try { po = new PerformanceObserver(l => { for (const e of l.getEntries()) longtasks.push(e.duration); }); po.observe({ entryTypes: ['longtask'] }); } catch (e) {}

  const pace = (ms, driver) => new Promise(res => {
    const d = []; let last = performance.now(), t0 = last;
    function loop(t) { const dt = t - last; last = t; if (d.length) d.push(dt); else d.push(0); if (driver) driver(t, dt);
      if (t - t0 < ms) requestAnimationFrame(loop);
      else { const s = d.slice(2).sort((a, b) => a - b); const n = s.length;
        res({ fps: +(n / (ms / 1000)).toFixed(1), p50: +s[Math.floor(n * 0.5)].toFixed(1), p95: +s[Math.floor(n * 0.95)].toFixed(1), worst: +(s[n - 1] || 0).toFixed(1) }); } }
    requestAnimationFrame(loop);
  });
  // Camera is driven by ELAPSED TIME (not frame count) so the path is identical
  // across variants and fps is comparable. (Frame-count drivers make a slower
  // variant take a different path -> confounded cross-variant fps.)
  out.pan = await pace(2500, (t) => { const a = t / 50; network.moveTo({ position: { x: Math.cos(a) * 900, y: Math.sin(a) * 900 }, animation: false }); });
  out.zoom = await pace(2500, (t) => { const a = t / 50; network.moveTo({ scale: 0.4 + 0.8 * Math.abs(Math.sin(a * 0.6)), animation: false }); });
  out.hover = await pace(2500, (t) => { const h = Math.round(t / 16); cv.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + (h % 40) - 20, clientY: cy + ((h * 7) % 40) - 20, bubbles: true })); });
  if (po) po.disconnect();
  out.longtask_n = longtasks.length;
  out.longtask_max = Math.round(Math.max(0, ...longtasks));
  out.longtask_total = Math.round(longtasks.reduce((x, y) => x + y, 0));
  out.pan_fps = out.pan.fps; out.zoom_fps = out.zoom.fps; out.hover_fps = out.hover.fps;
  return out;
};

const srv = await serve(LAB, 8211);
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run', '--no-default-browser-check', '--js-flags=--expose-gc'],
});
const ctx = await browser.newContext({ viewport: { width: VPW, height: VPH }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('HeapProfiler.enable').catch(() => {});

const nerrs = [];
page.on('pageerror', e => { if (nerrs.length < 6) nerrs.push(String(e.message).slice(0, 200)); });

const url = 'http://127.0.0.1:8211/' + FILE.replace(/\\/g, '/');
const t0 = Date.now();
let loadWall = null;
try {
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  loadWall = Date.now() - t0;
} catch (e) { loadWall = Date.now() - t0; }

let m = {};
try { m = await page.evaluate(BATTERY, { runs: RUNS }); } catch (e) { m = { error: String(e.message).slice(0, 200) }; }

let heapMB = null, heapDeltaMB = null;
try {
  await cdp.send('HeapProfiler.collectGarbage');
  await new Promise(r => setTimeout(r, 300));
  const h = await cdp.send('Runtime.getHeapUsage');
  heapMB = +(h.usedSize / 1048576).toFixed(2);
} catch (e) {}

await browser.close();
srv.close();

const row = {
  ts: new Date().toISOString().slice(0, 19), lane: LANE, variant: LABEL, graph: GRAPH, dpr: DPR,
  nodes: m.nodes ?? NODES, edges: m.edges ?? EDGES, communities: m.communities ?? '',
  labels: m.labels ?? '', arrows: m.arrows ?? '', dashed: m.dashed ?? '',
  canvas_px: m.canvas_px ?? '', load_wall_ms: loadWall,
  dcl_ms: m.dcl_ms ?? '', load_ms: m.load_ms ?? '',
  redraw_med: m.redraw_med ?? '', redraw_p95: m.redraw_p95 ?? '', redraw_min: m.redraw_min ?? '',
  pan_fps: m.pan_fps ?? '', zoom_fps: m.zoom_fps ?? '', hover_fps: m.hover_fps ?? '',
  longtask_n: m.longtask_n ?? '', longtask_max: m.longtask_max ?? '', longtask_total: m.longtask_total ?? '',
  heap_mb: heapMB ?? '', error: m.error ?? '',
};
const cols = Object.keys(row);
fs.mkdirSync(path.dirname(CSV), { recursive: true });
if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, cols.join(',') + '\n');
const line = cols.map(c => { const v = String(row[c]); return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
fs.appendFileSync(CSV, line + '\n');

console.log(JSON.stringify({ row, pageErrors: nerrs, csv: CSV }, null, 1));
