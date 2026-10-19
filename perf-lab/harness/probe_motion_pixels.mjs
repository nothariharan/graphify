// Does a frame drawn DURING a gesture match a frame drawn at rest?
//
// This is the fidelity question in the user's terms: they reported that lines vanish while
// moving the view, so "in motion looks the same as at rest" has to be measured, not
// asserted. Snapshot the graph canvas while the gesture is still held (camera frozen), then
// release and let vis redraw the same camera through its normal per-edge path, and compare
// the two framebuffers pixel by pixel.
//
// Run it on the *noborder* builds: with the node border lean active the two frames
// legitimately differ (borders are off mid-gesture), which would swamp the edge question.
//
//   node harness/probe_motion_pixels.mjs --file variants/batch-straight-noborder.html
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); });
});
await new Promise(r => srv.listen(8236, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8236/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(600);

const res = await page.evaluate(async (mode) => {
  const cv = document.querySelector('#graph canvas');
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window });
  const ctx = cv.getContext('2d');
  const grab = () => Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data);

  if (mode === 'zoom') {
    for (let i = 0; i < 6; i++) {
      cv.dispatchEvent(new WheelEvent('wheel', { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2, deltaY: -140, deltaMode: 0, bubbles: true, cancelable: true, view: window }));
      await new Promise(r => requestAnimationFrame(r));
    }
  } else {
    cv.dispatchEvent(mk('pointerdown', 120, 120));
    for (let i = 0; i < 6; i++) {
      cv.dispatchEvent(mk('pointermove', 120 + i * 26, 120 + i * 17));
      await new Promise(r => requestAnimationFrame(r));
    }
  }
  await new Promise(r => requestAnimationFrame(r));
  const during = grab();                       // frame drawn with the batch installed

  if (mode !== 'zoom') cv.dispatchEvent(mk('pointerup', 276, 221));
  await new Promise(r => setTimeout(r, 500));  // lean/zoom timer restores, redraw happens
  const atRest = grab();                       // same camera, vis's own per-edge draw

  let differing = 0, worst = 0, sum = 0, painted = 0;
  for (let i = 0; i < during.length; i += 4) {
    const a = during[i] - atRest[i], b = during[i + 1] - atRest[i + 1], c = during[i + 2] - atRest[i + 2];
    const d = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
    if (d > 0) sum += d;
    if (d > worst) worst = d;
    if (d > 16) differing++;
    if (atRest[i] > 24 || atRest[i + 1] > 24 || atRest[i + 2] > 24) painted++;   // non-background pixels
  }
  const px = during.length / 4;
  return {
    camera: { scale: network.getScale(), position: network.getViewPosition() },
    pixels: px, painted, differing, worst, meanDiffOfDiffering: differing ? sum / differing : 0,
    pctOfPainted: painted ? (100 * differing / painted) : 0,
  };
}, MODE);

await browser.close();
srv.close();
console.log(`${path.basename(FILE)}  [${MODE}]  camera scale=${res.camera.scale.toFixed(4)}`);
console.log(`  canvas ${res.pixels} px, of which ${res.painted} non-background`);
console.log(`  pixels differing by >16: ${res.differing}  (${res.pctOfPainted.toFixed(2)}% of painted, worst channel delta ${res.worst}, mean ${res.meanDiffOfDiffering.toFixed(1)})`);
