// Functional check for the lean gesture: does the node border actually stop being
// stroked during a drag? Patches CanvasRenderingContext2D so every stroke() and every
// lineWidth write is counted, then runs the same synthetic drag the A/B uses.
//
// vis strokes node borders with lineWidth == borderWidth (1.5 in this build), and edges
// use their own widths, so a histogram of lineWidth values during a drag says exactly
// which layers drew. A lean build must show ~0 writes of 1.5 and far fewer strokes.
//
//   node harness/probe_borderdraw.mjs --file variants/base-rsl.html
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
const VMODE = arg('mode', 'node');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(8230, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8230/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(600);

const out = await page.evaluate(async (mode) => {
  const proto = CanvasRenderingContext2D.prototype;
  const lwDesc = Object.getOwnPropertyDescriptor(proto, 'lineWidth');
  const stroke = proto.stroke;
  window.__lw = {}; window.__strokes = 0; window.__counting = false;
  window.__bez = 0; window.__line = 0;
  const bez = proto.bezierCurveTo, line = proto.lineTo;
  Object.defineProperty(proto, 'lineWidth', {
    configurable: true,
    get() { return lwDesc.get.call(this); },
    set(v) { if (window.__counting) window.__lw[v] = (window.__lw[v] || 0) + 1; lwDesc.set.call(this, v); },
  });
  proto.stroke = function (...a) { if (window.__counting) window.__strokes++; return stroke.apply(this, a); };
  proto.bezierCurveTo = function (...a) { if (window.__counting) window.__bez++; return bez.apply(this, a); };
  proto.lineTo = function (...a) { if (window.__counting) window.__line++; return line.apply(this, a); };
  const reset = () => { window.__lw = {}; window.__strokes = 0; window.__bez = 0; window.__line = 0; };

  const cv = document.querySelector('#graph canvas');
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window });

  // find a node near the middle, else an empty spot
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  let target = null, bd = Infinity;
  for (const id of nodesDS.getIds()) {
    const p = network.canvasToDOM(network.getPosition(id));
    if (p.x < 60 || p.y < 60 || p.x > window.innerWidth - 60 || p.y > window.innerHeight - 60) continue;
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d < bd) { bd = d; target = p; }
  }
  if (mode === 'pan') target = { x: 40, y: 40 };

  try { network.fit({ animation: false }); } catch (e) {}
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // baseline: at rest, borders are on in every build
  window.__counting = true; reset();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const atRest = { strokes: window.__strokes, bez: window.__bez, line: window.__line, lw: { ...window.__lw } };

  // during a drag (or a zoom, which is wheel-driven)
  reset();
  const zoomMode = mode === 'zoom';
  if (zoomMode) {
    for (let i = 0; i < 14; i++) {
      cv.dispatchEvent(new WheelEvent('wheel', {
        clientX: cx, clientY: cy, deltaY: Math.sin(i / 14 * Math.PI * 2) * 160,
        deltaMode: 0, bubbles: true, cancelable: true, view: window,
      }));
      await new Promise(r => requestAnimationFrame(r));
    }
  } else {
    cv.dispatchEvent(mk('pointerdown', target.x, target.y));
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * Math.PI * 2;
      cv.dispatchEvent(mk('pointermove', target.x + Math.cos(a) * 120, target.y + Math.sin(a) * 120));
      await new Promise(r => requestAnimationFrame(r));
    }
  }
  const during = { strokes: window.__strokes, bez: window.__bez, line: window.__line, lw: { ...window.__lw } };
  if (!zoomMode) cv.dispatchEvent(mk('pointerup', target.x, target.y));

  // Direct-mutation lean does NOT trigger a redraw of its own, so the question is
  // whether vis redraws by itself at dragEnd (it must, to bring the edges back). Watch
  // the frames right after pointer-up: borders restored here means no explicit redraw
  // is needed in the shipped code.
  reset();
  await new Promise((res) => { let k = 0; (function f() { if (++k > 20) return res(); requestAnimationFrame(f); })(); });
  const postRelease = { strokes: window.__strokes, lw: { ...window.__lw } };

  // After the gesture settles, borders must come back. vis only redraws when something
  // changed, so wait out the lean build's ~180ms idle restore, then force a redraw and
  // count: a restored border shows as strokes at lineWidth == borderWidth/scale.
  await new Promise(r => setTimeout(r, 600));
  reset(); window.__counting = true;
  network.redraw();
  await new Promise(r => requestAnimationFrame(r));
  const after = { strokes: window.__strokes, lw: { ...window.__lw } };
  window.__counting = false;

  return { mode, target, atRest, during, postRelease, after };
}, VMODE);

await browser.close();
srv.close();
const fmt = (o) => `strokes=${o.strokes} bezier=${o.bez} lineTo=${o.line} lineWidth=${JSON.stringify(o.lw)}`;
console.log(`${path.basename(FILE)} [${out.mode}]`);
console.log(`  at rest : ${fmt(out.atRest)}`);
console.log(`  during  : ${fmt(out.during)}`);
console.log(`  released: ${fmt(out.postRelease)}`);
console.log(`  after   : ${fmt(out.after)}`);
