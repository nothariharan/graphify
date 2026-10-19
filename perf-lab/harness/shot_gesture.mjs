// Screenshot a page *while a gesture is in progress* (pan held, or mid-zoom), so the
// in-motion look can be eyeballed: with the lean-edge lever the graph must still show
// every line, just straight for the length of the gesture.
//
//   node harness/shot_gesture.mjs --file variants/edge-lean-dynamic.html --mode pan --out shots/lean-pan.png
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
const MODE = arg('mode', 'pan');
const OUT = arg('out', null);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); });
});
await new Promise(r => srv.listen(8234, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8234/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(500);

// Hold the gesture open (never dispatch pointerup), then screenshot while the lean is
// still applied: dragStart has fired, dragEnd has not.
await page.evaluate(async (mode) => {
  const cv = document.querySelector('#graph canvas');
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window });
  if (mode === 'zoom') {
    for (let i = 0; i < 8; i++) {
      cv.dispatchEvent(new WheelEvent('wheel', { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2, deltaY: -160, deltaMode: 0, bubbles: true, cancelable: true, view: window }));
      await new Promise(r => requestAnimationFrame(r));
    }
    return;
  }
  cv.dispatchEvent(mk('pointerdown', 200, 200));
  for (let i = 0; i < 8; i++) {
    cv.dispatchEvent(mk('pointermove', 200 + i * 22, 200 + i * 16));
    await new Promise(r => requestAnimationFrame(r));
  }
}, MODE);
await page.screenshot({ path: path.join(LAB, OUT || `shots/${path.basename(FILE, '.html')}-${MODE}.png`) });
console.log(`wrote ${OUT || `shots/${path.basename(FILE, '.html')}-${MODE}.png`}`);
await browser.close();
srv.close();
