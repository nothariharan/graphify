// Mid-gesture inspection of the edge instances: does writing width/smooth onto
// network.body.edges[id].options actually reach vis's edge draw path?
//
//   node harness/debug_edgelean.mjs --file variants/edge-lean-dynamic.html
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); });
});
await new Promise(r => srv.listen(8233, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8233/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(600);

const out = await page.evaluate(async () => {
  const html = document.documentElement.innerHTML;
  const cv = document.querySelector('#graph canvas');
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window });

  // instrument the canvas the same way probe_borderdraw does
  const proto = CanvasRenderingContext2D.prototype;
  const lwDesc = Object.getOwnPropertyDescriptor(proto, 'lineWidth');
  const stroke = proto.stroke, bez = proto.bezierCurveTo, line = proto.lineTo;
  window.__lw = {}; window.__strokes = 0; window.__bez = 0; window.__line = 0; window.__counting = false;
  Object.defineProperty(proto, 'lineWidth', {
    configurable: true,
    get() { return lwDesc.get.call(this); },
    set(v) { if (window.__counting) window.__lw[v] = (window.__lw[v] || 0) + 1; lwDesc.set.call(this, v); },
  });
  proto.stroke = function (...a) { if (window.__counting) window.__strokes++; return stroke.apply(this, a); };
  proto.bezierCurveTo = function (...a) { if (window.__counting) window.__bez++; return bez.apply(this, a); };
  proto.lineTo = function (...a) { if (window.__counting) window.__line++; return line.apply(this, a); };
  const draws = () => ({ strokes: window.__strokes, bezier: window.__bez, lineTo: window.__line, lw: { ...window.__lw } });
  const reset = () => { window.__lw = {}; window.__strokes = 0; window.__bez = 0; window.__line = 0; };

  const snap = (label) => {
    const es = network.body && network.body.edges;
    const ids = es ? Object.keys(es) : [];
    const first = ids.length ? es[ids[0]].options : null;
    const widths = {}, smooths = {};
    for (const id of ids) {
      const o = es[id].options;
      widths[o.width] = (widths[o.width] || 0) + 1;
      const key = String(o.smooth && o.smooth.type ? o.smooth.type : o.smooth);
      smooths[key] = (smooths[key] || 0) + 1;
    }
    return { label, edgesInBody: ids.length, sampleWidth: first ? first.width : null, sampleSmooth: first ? JSON.stringify(first.smooth) : null, widthHistogram: widths, smoothHistogram: smooths };
  };

  const before = snap('at rest');
  window.__counting = true;
  cv.dispatchEvent(mk('pointerdown', 40, 40));
  for (let i = 0; i < 10; i++) {
    cv.dispatchEvent(mk('pointermove', 40 + i * 12, 40 + i * 9));
    await new Promise(r => requestAnimationFrame(r));
    if (i === 4) { reset(); }   // count only once the gesture is definitely engaged
  }
  const during = snap('mid pan');
  const drawDuring = draws();

  // Phase B: still panning, also write the cached value on the instance itself.
  const es = network.body.edges;
  const ids = Object.keys(es);
  const instKeys = ids.length ? Object.keys(es[ids[0]]).sort() : [];
  const optKeys = ids.length && es[ids[0]].options ? Object.keys(es[ids[0]].options).sort() : [];
  let cachedSmoothKey = null;
  for (const k of instKeys.slice()) {
    try { if (typeof es[ids[0]][k] === 'object' && es[ids[0]][k] && 'smooth' in es[ids[0]][k]) { /* nested */ } } catch (e) {}
  }
  for (const id of ids) {
    const e = es[id];
    if (!e) continue;
    if ('smooth' in e) { cachedSmoothKey = 'smooth'; e.smooth = false; }
  }
  reset();
  for (let i = 10; i < 16; i++) {
    cv.dispatchEvent(mk('pointermove', 40 + i * 12, 40 + i * 9));
    await new Promise(r => requestAnimationFrame(r));
  }
  const drawPhaseB = draws();
  cv.dispatchEvent(mk('pointerup', 232, 184));
  window.__counting = false;
  await new Promise(r => setTimeout(r, 500));
  const after = snap('after release');
  return { hasLeanEdges: html.includes('_leanEdges'), before, during, after, drawDuring, drawPhaseB, instKeys, optKeys, cachedSmoothKey };
});

await browser.close();
srv.close();
console.log(`${path.basename(FILE)}  injectedLeannEdges=${out.hasLeanEdges}`);
for (const k of ['before', 'during', 'after']) {
  const s = out[k];
  console.log(`  ${s.label.padEnd(13)} edges=${s.edgesInBody} sampleWidth=${s.sampleWidth} sampleSmooth=${s.sampleSmooth}`);
  console.log(`                widthHistogram=${JSON.stringify(s.widthHistogram)}`);
  console.log(`                smoothHistogram=${JSON.stringify(s.smoothHistogram)}`);
}
const d = out.drawDuring;
console.log(`  draw ops mid-pan (options mutated): strokes=${d.strokes} bezierCurveTo=${d.bezier} lineTo=${d.lineTo}`);
console.log(`  lineWidth histogram mid-pan: ${JSON.stringify(d.lw)}`);
const b = out.drawPhaseB;
console.log(`  draw ops after also writing instance.smooth: strokes=${b.strokes} bezierCurveTo=${b.bezier} lineTo=${b.lineTo}`);
console.log(`  edge instance keys: ${JSON.stringify(out.instKeys)}`);
console.log(`  edge options keys:  ${JSON.stringify(out.optKeys)}`);
console.log(`  cachedSmoothKey found on instance: ${out.cachedSmoothKey}`);
