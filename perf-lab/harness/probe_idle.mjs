// Does the resting page draw at all?
//
//   node harness/probe_idle.mjs --file view/after.html
//
// Loads the artifact, lets the scene settle (the known delayed pass on the 3rd draw), then
// counts canvas draws, strokes, fills and rAF callbacks for a fixed window with no input.
// If something keeps redrawing, it prints the first few stacks that asked for the redraw.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const FILE = arg('file');
const IDLE_MS = Number(arg('idle-ms', '3000'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8260, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://127.0.0.1:8260/' + FILE, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2000);

const out = await page.evaluate(async (idleMs) => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  const r = { draws: 0, strokes: 0, fills: 0, raf: 0, redrawCalls: [], stacks: [] };

  // what asks for a redraw?
  const seen = new Set();
  const wrapRedraw = (obj, name) => {
    if (!obj || typeof obj.redraw !== 'function') return;
    const orig = obj.redraw.bind(obj);
    obj.redraw = function (...a) {
      r.redrawCalls.push(name);
      const st = new Error().stack || '';
      const key = st.split('\n').slice(1, 5).join('|');
      if (!seen.has(key) && r.stacks.length < 6) { seen.add(key); r.stacks.push(st); }
      return orig(...a);
    };
  };
  wrapRedraw(network, 'network.redraw');
  try { wrapRedraw(network.canvas, 'canvas.redraw'); } catch (e) {}

  network.on('afterDrawing', () => { r.draws++; });
  const os = ctx.stroke.bind(ctx), of = ctx.fill.bind(ctx);
  ctx.stroke = function (...a) { r.strokes++; return os(...a); };
  ctx.fill = function (...a) { r.fills++; return of(...a); };
  const oraf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    r.raf++;
    return oraf(cb);
  };

  await new Promise((res) => setTimeout(res, 300));
  r.draws = 0; r.strokes = 0; r.fills = 0; r.raf = 0;
  r.redrawCalls.length = 0; r.stacks.length = 0; seen.clear();
  const t0 = performance.now();
  await new Promise((res) => setTimeout(res, idleMs));
  r.windowMs = Math.round(performance.now() - t0);

  // one hover in and out, then another quiet window
  try { network.emit('hoverNode', { node: Object.keys(network.body.nodes)[0] }); } catch (e) {}
  await new Promise((res) => setTimeout(res, 400));
  try { network.emit('blurNode', { node: Object.keys(network.body.nodes)[0] }); } catch (e) {}
  await new Promise((res) => setTimeout(res, 300));
  r.hoverDraws = r.draws;

  r.after = { draws: 0, strokes: 0, fills: 0, raf: 0 };
  r.draws = 0; r.strokes = 0; r.fills = 0; r.raf = 0; r.redrawCalls.length = 0; r.stacks.length = 0; seen.clear();
  await new Promise((res) => setTimeout(res, idleMs));
  r.after.draws = r.draws;
  r.after.strokes = r.strokes;
  r.after.fills = r.fills;
  r.after.raf = r.raf;
  r.after.redrawCalls = r.redrawCalls.slice();
  r.after.stacks = r.stacks.slice();
  return r;
}, IDLE_MS);

console.log(`${FILE}  canvas ${await page.evaluate(() => document.querySelector('#graph canvas').width)}x${await page.evaluate(() => document.querySelector('#graph canvas').height)}`);
console.log(`  idle ${out.windowMs} ms: draws=${out.draws} strokes=${out.strokes} fills=${out.fills} rAF=${out.raf} redraw calls=${out.redrawCalls.length}`);
console.log(`  after hover in+out, next idle window: draws=${out.after.draws} strokes=${out.after.strokes} fills=${out.after.fills} rAF=${out.after.raf} redraw calls=${out.after.redrawCalls.length}`);
if (out.after.redrawCalls.length) console.log(`  redraw callers: ${JSON.stringify(out.after.redrawCalls.slice(0, 8))}`);
for (const st of out.after.stacks.slice(0, 3)) console.log('  stack:\n' + st.split('\n').slice(0, 5).map((l) => '    ' + l.trim()).join('\n'));
if (errors.length) console.log('  errors: ' + errors.slice(0, 3).join(' | '));
else console.log('  errors: none');

await browser.close();
srv.close();
