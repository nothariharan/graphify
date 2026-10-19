// Can synthetic DOM pointer/mouse events drive vis-network's DRAG in-page?
// If yes, gestures can be paced at true display rate (no CDP round-trip per step).
//   node harness/test_synth_drag.mjs --file variants/base-ours-fixed.html
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
const FILE = arg('file', 'variants/base-ours-fixed.html');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(8221, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8221/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.waitForTimeout(4000);

const res = await page.evaluate(async () => {
  const cv = document.querySelector('#graph canvas');
  const pick = () => {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    let best = null, bd = Infinity;
    for (const id of nodesDS.getIds()) {
      const p = network.canvasToDOM(network.getPosition(id));
      if (p.x < 60 || p.y < 60 || p.x > innerWidth - 60 || p.y > innerHeight - 60) continue;
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bd) { bd = d; best = { id, x: p.x, y: p.y }; }
    }
    return best;
  };
  const t = pick();
  const before = network.getPosition(t.id);
  const out = { target: t, dragStart: 0, dragging: 0, dragEnd: 0, moved: null, kind: null };

  const mk = (type, x, y, ptr) => ptr
    ? new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window })
    : new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, view: window });

  network.on('dragStart', () => out.dragStart++);
  network.on('dragging', () => out.dragging++);
  network.on('dragEnd', () => out.dragEnd++);

  const run = (ptr) => new Promise((done) => {
    const ev = (type, x, y) => cv.dispatchEvent(mk(type, x, y, ptr));
    const downType = ptr ? 'pointerdown' : 'mousedown';
    const moveType = ptr ? 'pointermove' : 'mousemove';
    const upType = ptr ? 'pointerup' : 'mouseup';
    ev(downType, t.x, t.y);
    let i = 0;
    const N = 30;
    (function step() {
      const a = i / N * Math.PI * 2;
      ev(moveType, t.x + Math.cos(a) * 90, t.y + Math.sin(a) * 90);
      if (++i <= N) requestAnimationFrame(step);
      else { ev(upType, t.x, t.y); done(); }
    })();
  });

  await run(true);
  out.kind = 'pointer';
  out.moved = Math.hypot(network.getPosition(t.id).x - before.x, network.getPosition(t.id).y - before.y);
  if (out.moved < 1) {
    out.dragStart = out.dragging = out.dragEnd = 0;
    await run(false);
    out.kind = 'mouse';
    out.moved = Math.hypot(network.getPosition(t.id).x - before.x, network.getPosition(t.id).y - before.y);
  }
  out.before = before;
  out.after = network.getPosition(t.id);
  return out;
});

await browser.close();
srv.close();
const ok = res.dragging > 5 && res.moved > 1;
console.log(JSON.stringify({ syntheticDragWorks: ok, ...res }, null, 1));
