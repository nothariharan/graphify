// sigma.js (WebGL) measurement battery — same shape as measure.mjs so rows are
// directly comparable in the same CSV.
//   node harness/measure_sigma.mjs --file variants/rsl__s00-sigma.html --label s00-sigma \
//        --graph rsl --lane L7 --runs 15
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const FILE = arg('file');
const LABEL = arg('label');
const LANE = arg('lane', 'L7');
const GRAPH = arg('graph', 'n/a');
const DPR = parseFloat(arg('dpr', '1'));
const RUNS = parseInt(arg('runs', '15'));
const CSV = arg('csv', path.join(LAB, 'results', 'measurements.csv'));
const VPW = parseInt(arg('vw', '1280'));
const VPH = parseInt(arg('vh', '800'));
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

const BATTERY = async (cfg) => {
  const nav = performance.getEntriesByType('navigation')[0];
  const cv = document.querySelector('#c canvas');
  if (!cv) return { error: 'no canvas' };
  if (typeof renderer === 'undefined' || typeof graphologyGraph === 'undefined') return { error: 'sigma not ready' };
  const rect = cv.getBoundingClientRect();
  const cx = Math.round(rect.left + rect.width / 2), cy = Math.round(rect.top + rect.height / 2);
  const cam = renderer.getCamera();
  const out = {};
  out.dcl_ms = Math.round(nav.domContentLoadedEventEnd);
  out.load_ms = Math.round(nav.loadEventEnd);
  out.nodes = graphologyGraph.order;
  out.edges = graphologyGraph.size;
  out.communities = new Set(graphologyGraph.mapNodes(n => graphologyGraph.getNodeAttribute(n, 'color'))).size;
  out.canvas_w = cv.width; out.canvas_h = cv.height;
  out.canvas_px = cv.width * cv.height;
  out.dpr = window.devicePixelRatio;

  // "redraw" = cost to produce one full frame through the WebGL renderer
  const tr = () => new Promise(res => {
    const t0 = performance.now();
    renderer.refresh();
    requestAnimationFrame(() => res(performance.now() - t0));
  });
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
    function loop(t) { const dt = t - last; last = t; d.push(d.length ? dt : 0); if (driver) driver(t, dt);
      if (t - t0 < ms) requestAnimationFrame(loop);
      else { const s = d.slice(2).sort((a, b) => a - b); const n = s.length;
        res({ fps: +(n / (ms / 1000)).toFixed(1) }); } }
    requestAnimationFrame(loop);
  });
  // same elapsed-time camera driver as the vis battery
  const home = cam.getState();
  const r0 = home.ratio || 1;
  out.pan = await pace(2500, (t) => { const a = t / 50; cam.setState({ x: Math.cos(a) * 900, y: Math.sin(a) * 900 }); });
  out.zoom = await pace(2500, (t) => { const a = t / 50; cam.setState({ ratio: r0 * (0.5 + 1.0 * Math.abs(Math.sin(a * 0.6))) }); });
  out.hover = await pace(2500, (t) => { const h = Math.round(t / 16); cv.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + (h % 40) - 20, clientY: cy + ((h * 7) % 40) - 20, bubbles: true })); });
  cam.setState(home);
  if (po) po.disconnect();
  out.longtask_n = longtasks.length;
  out.longtask_max = Math.round(Math.max(0, ...longtasks));
  out.longtask_total = Math.round(longtasks.reduce((x, y) => x + y, 0));
  out.pan_fps = out.pan.fps; out.zoom_fps = out.zoom.fps; out.hover_fps = out.hover.fps;
  return out;
};

const srv = await serve(LAB, 8217);
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

const url = 'http://127.0.0.1:8217/' + FILE.replace(/\\/g, '/');
const t0 = Date.now();
let loadWall = null;
try { await page.goto(url, { waitUntil: 'load', timeout: 90000 }); loadWall = Date.now() - t0; }
catch (e) { loadWall = Date.now() - t0; }

let m = {};
try { m = await page.evaluate(BATTERY, { runs: RUNS }); } catch (e) { m = { error: String(e.message).slice(0, 200) }; }

let heapMB = null;
try { await cdp.send('HeapProfiler.collectGarbage'); await new Promise(r => setTimeout(r, 300));
  const h = await cdp.send('Runtime.getHeapUsage'); heapMB = +(h.usedSize / 1048576).toFixed(2); } catch (e) {}

await browser.close();
srv.close();

const row = {
  ts: new Date().toISOString().slice(0, 19), lane: LANE, variant: LABEL, graph: GRAPH, dpr: DPR,
  nodes: m.nodes ?? '', edges: m.edges ?? '', communities: m.communities ?? '',
  labels: '', arrows: '', dashed: '',
  canvas_px: m.canvas_px ?? '', load_wall_ms: loadWall,
  dcl_ms: m.dcl_ms ?? '', load_ms: m.load_ms ?? '',
  redraw_med: m.redraw_med ?? '', redraw_p95: m.redraw_p95 ?? '', redraw_min: m.redraw_min ?? '',
  pan_fps: m.pan_fps ?? '', zoom_fps: m.zoom_fps ?? '', hover_fps: m.hover_fps ?? '',
  longtask_n: m.longtask_n ?? '', longtask_max: m.longtask_max ?? '', longtask_total: m.longtask_total ?? '',
  heap_mb: heapMB ?? '', error: m.error ?? '',
};
const cols = Object.keys(row);
if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, cols.join(',') + '\n');
const line = cols.map(c => { const v = String(row[c]); return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
fs.appendFileSync(CSV, line + '\n');
console.log(JSON.stringify({ row, pageErrors: nerrs }, null, 1));
