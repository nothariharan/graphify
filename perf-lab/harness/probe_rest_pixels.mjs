// At-rest fidelity for the edge batch: with the batch installed, does the resting frame
// match the frame vis draws edge by edge? Same camera, same nodes, same colours - only the
// edge draw path differs.
//
//   node harness/probe_rest_pixels.mjs --file variants/base-ours-v10.html [--dump 1] [--mono 1]
//
// Method notes (these cost a wrong number once already):
// - the scene must settle first: a fresh page's first two idle frames differ from the
//   settled frame by ~40k px because of one delayed pass on the 3rd draw,
// - each side gets a real redraw and ~350 ms to be painted, otherwise the "plain" capture
//   can still be a batched frame,
// - the batch->batch round trip is reported as a control: it must be 0.
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
const SHOT = arg('shot', '');
const DUMP = arg('dump', '0') === '1';
const MONO = arg('mono', '0') === '1';

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8242, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8242/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1200);

const res = await page.evaluate(async ({ wantDump, mono }) => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  const grab = () => Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const diff = (a, b) => {
    let n = 0, worst = 0, sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > 0) sum += d;
      if (d > worst) worst = d;
      if (d > 16) n++;
    }
    return { n, worst, mean: n ? sum / n : 0 };
  };
  const paintedOf = (a) => {
    let p = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] > 24 || a[i + 1] > 24 || a[i + 2] > 24) p++;
    return p;
  };
  const setRest = (on) => {
    if (typeof _EDGE_BATCH.setRest === 'function') { _EDGE_BATCH.setRest(on); return 'setRest'; }
    if (typeof _REST_BATCH_ON !== 'undefined') { _REST_BATCH_ON = on; _EDGE_BATCH.set(on); return 'legacy'; }
    return 'none';
  };
  const patched = () => Object.keys(network.body.edges).filter((k) => {
    const et = network.body.edges[k].edgeType;
    return et && Object.prototype.hasOwnProperty.call(et, 'drawLine');
  }).length;

  // 1. settle: two consecutive redraws must be identical
  let settled = false, prev = null, settleDiff = -1;
  for (let i = 0; i < 12 && !settled; i++) {
    network.redraw();
    await wait(300);
    const cur = grab();
    if (prev) {
      const d = diff(prev, cur);
      if (d.n === 0) { settled = true; settleDiff = 0; } else settleDiff = d.n;
    }
    prev = cur;
  }

  // 2. same-colour control: with every edge one colour and solid, only geometry can differ
  if (mono) {
    const items = edgesDS.get().map((x) => ({ id: x.id, color: { color: '#9aa0a6', opacity: 0.7 }, dashes: false }));
    edgesDS.update(items);
    await wait(600);
  }

  // 3. batched frame
  setRest(true);
  network.redraw();
  await wait(350);
  const batched = grab();
  const batchedEdges = patched();

  // 4. vis frame
  setRest(false);
  network.redraw();
  await wait(350);
  const plain = grab();
  const plainEdges = patched();

  // 5. back to the batch, as a control: the same draw path must give the same pixels
  setRest(true);
  network.redraw();
  await wait(350);
  const batched2 = grab();

  const d1 = diff(batched, plain);
  const control = diff(batched, batched2);
  const painted = paintedOf(plain);

  let dump = null;
  if (wantDump) {
    const mk = (fn) => {
      const c = document.createElement('canvas');
      c.width = cv.width; c.height = cv.height;
      const x = c.getContext('2d');
      const img = x.createImageData(cv.width, cv.height);
      for (let p = 0, i = 0; p < cv.width * cv.height; p++, i += 4) {
        const v = fn(i);
        img.data[i] = v[0]; img.data[i + 1] = v[1]; img.data[i + 2] = v[2]; img.data[i + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    };
    dump = {
      batched: mk((i) => [batched[i], batched[i + 1], batched[i + 2]]),
      plain: mk((i) => [plain[i], plain[i + 1], plain[i + 2]]),
      diff: mk((i) => {
        const dd = Math.max(Math.abs(batched[i] - plain[i]), Math.abs(batched[i + 1] - plain[i + 1]), Math.abs(batched[i + 2] - plain[i + 2]));
        return dd > 16 ? [255, 0, 255] : [plain[i] >> 2, plain[i + 1] >> 2, plain[i + 2] >> 2];
      }),
    };
  }
  return {
    camera: { scale: network.getScale(), position: network.getViewPosition() },
    settled, settleDiff,
    pixels: batched.length / 4, painted,
    differing: d1.n, worst: d1.worst, mean: d1.mean,
    pctOfPainted: painted ? (100 * d1.n / painted) : 0,
    controlDiffering: control.n,
    batchedEdges, plainEdges, dump,
  };
}, { wantDump: DUMP, mono: MONO });

if (SHOT) await page.screenshot({ path: SHOT });
if (res.dump) {
  for (const [k, uri] of Object.entries(res.dump)) {
    fs.writeFileSync(path.join(LAB, 'shots', `rest-diff-${k}.png`), Buffer.from(uri.split(',')[1], 'base64'));
  }
  console.log('  wrote shots/rest-diff-{batched,plain,diff}.png');
}

await browser.close();
srv.close();
console.log(`${path.basename(FILE)}  camera scale=${res.camera.scale.toFixed(4)}  settled=${res.settled} (last settle diff ${res.settleDiff} px)`);
console.log(`  patched edges: batched ${res.batchedEdges} -> plain ${res.plainEdges}`);
console.log(`  canvas ${res.pixels} px, of which ${res.painted} non-background`);
console.log(`  pixels differing by >16: ${res.differing}  (${res.pctOfPainted.toFixed(2)}% of painted, worst channel delta ${res.worst}, mean ${res.mean.toFixed(1)})`);
console.log(`  control, batch -> batch: ${res.controlDiffering} px differing (must be 0)`);
