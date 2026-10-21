// Pixel comparison of two builds at rest: same camera, same data, only the change under
// test differs. Used for the L21 border swap, where the claim is "the same picture, one
// fill instead of a fill plus a hairline stroke".
//
//   node harness/probe_frame_cmp.mjs --a variants/base-ours-v10.html --b variants/L21-noborder.html
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
const A = arg('a');
const B = arg('b');
const DUMP = arg('dump', '0') === '1';

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8269, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function grab(file) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:8269/' + file.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => {
    try { return network.physics.options.enabled === false; } catch (e) { return false; }
  }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(2000);
  // settle: two identical consecutive frames
  const settled = await page.evaluate(async () => {
    const cv = document.querySelector('#graph canvas');
    const ctx = cv.getContext('2d');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const grab = () => Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data);
    const same = (a, b) => {
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) > 0 || Math.abs(a[i + 1] - b[i + 1]) > 0 || Math.abs(a[i + 2] - b[i + 2]) > 0) return false;
      }
      return true;
    };
    let prev = null;
    for (let i = 0; i < 10; i++) {
      network.redraw();
      await wait(300);
      const cur = grab();
      if (prev && same(prev, cur)) return true;
      prev = cur;
    }
    return false;
  });
  const data = await page.evaluate(() => {
    const cv = document.querySelector('#graph canvas');
    const ctx = cv.getContext('2d');
    // Same camera in both builds: the fit differs by 1.2% when the node size changes,
    // and a scaled picture cannot be compared pixel by pixel.
    network.moveTo({ position: { x: 0, y: 0 }, scale: 0.08, animation: false });
    network.redraw();
    return {
      px: Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data),
      scale: network.getScale(),
      pos: network.getViewPosition(),
      sample: (() => {
        const p = network.getPositions();
        const keys = Object.keys(p).slice(0, 40);
        return keys.map((k) => [Math.round(p[k].x * 100) / 100, Math.round(p[k].y * 100) / 100]);
      })(),
    };
  });
  await page.close();
  return { ...data, settled };
}

const a = await grab(A);
const b = await grab(B);
let differing = 0, worst = 0, painted = 0, onlyA = 0, onlyB = 0;
const W = 1000, H = 800;
for (let i = 0; i < a.px.length; i += 4) {
  const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]));
  if (d > worst) worst = d;
  if (d > 16) differing++;
  const pa = a.px[i] > 24 || a.px[i + 1] > 24 || a.px[i + 2] > 24;
  const pb = b.px[i] > 24 || b.px[i + 1] > 24 || b.px[i + 2] > 24;
  if (pa) painted++;
  if (pa && !pb) onlyA++;
  if (pb && !pa) onlyB++;
}
console.log(`${path.basename(A)} vs ${path.basename(B)}`);
console.log(`  settled: ${a.settled} / ${b.settled}   camera scale ${a.scale.toFixed(4)} vs ${b.scale.toFixed(4)}`);
// did the layout itself change? compare the first 40 node positions
let moved = 0, maxMove = 0;
for (let i = 0; i < Math.min(a.sample.length, b.sample.length); i++) {
  const d = Math.max(Math.abs(a.sample[i][0] - b.sample[i][0]), Math.abs(a.sample[i][1] - b.sample[i][1]));
  if (d > 0.5) moved++;
  if (d > maxMove) maxMove = d;
}
console.log(`  layout: ${moved}/${a.sample.length} sampled nodes moved (max ${maxMove.toFixed(2)} world units)`);
console.log(`  painted ${painted}, differing by >16: ${differing} (${(100 * differing / painted).toFixed(2)}% of painted), worst delta ${worst}`);
console.log(`  only in A: ${onlyA}, only in B: ${onlyB}`);

if (DUMP) {
  console.log('  (dump not implemented)');
}
await browser.close();
srv.close();
