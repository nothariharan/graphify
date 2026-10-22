// L25 — dump the layout a build actually produces, so the metrics kernel can score it.
//
//   node harness/l25_dump.mjs --file variants/base-ours-v13.html --out results/l25-rsl-browser.json
//
// Fresh browser context every run => empty localStorage => the solver runs, so the dump is
// the 200-iteration layout the user sees on a first open, not a cached one.
// The dump is the input for harness/l25_metrics.py (one kernel, so browser and numpy layouts
// are scored by exactly the same code for exactly the same graph).
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
const OUT = arg('out');
const SHOT = arg('shot', '');
const PORT = +(arg('port', '8263'));

if (!FILE || !OUT) { console.error('need --file and --out'); process.exit(2); }

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/` + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try {
    return typeof network !== 'undefined' && network.physics.options.enabled === false &&
      network.body && Object.keys(network.body.nodes).length > 0;
  } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(700);
const ready_ms = Date.now() - t0;

const dump = await page.evaluate(() => {
  const cont = document.getElementById('graph');
  const pos = network.getPositions();
  const scale = network.getScale();
  const view = network.getViewPosition();
  const nodes = RAW_NODES.map((n) => ({
    id: n.id, label: n.label, community: n.community, degree: n.degree,
    size: n.size, font: n.font && n.font.size,
  }));
  const edges = edgesDS.get().map((e) => [e.from, e.to]);
  const positions = {};
  for (const id in pos) positions[id] = [pos[id].x, pos[id].y];
  return {
    canvas: { w: cont.clientWidth, h: cont.clientHeight },
    scale, view,
    nodes, edges, positions,
  };
});

const out = {
  source: 'browser', file: path.basename(FILE), ready_ms,
  viewport: { w: 1280, h: 800 }, errors: errors.slice(0, 3),
  ...dump,
};
fs.mkdirSync(path.dirname(path.join(LAB, OUT)), { recursive: true });
fs.writeFileSync(path.join(LAB, OUT), JSON.stringify(out));
if (SHOT) await page.screenshot({ path: path.join(LAB, SHOT) });
console.log(JSON.stringify({
  file: out.file, ready_ms, canvas: out.canvas, scale: +out.scale.toFixed(5),
  nodes: out.nodes.length, edges: out.edges.length, errors: out.errors.length,
}));
await browser.close();
srv.close();
