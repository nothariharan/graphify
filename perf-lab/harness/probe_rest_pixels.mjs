// At-rest fidelity for the L12 rest batch: with the batch installed, does the resting
// frame match the frame vis draws edge by edge? Same camera, same nodes, same colours -
// only the edge draw path differs.
//
//   node harness/probe_rest_pixels.mjs --file variants/L12-rest-batch.html
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
await page.waitForTimeout(900);

const res = await page.evaluate(async ({ wantDump, mono }) => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  const grab = () => Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data);
  const tick = () => new Promise((r) => requestAnimationFrame(() => r()));

  // Same-colour control: with every edge one colour and solid, the only thing that could
  // still differ between the two draw paths is geometry, not the order of overlapping
  // strokes. Ids come from the DataSet itself, because its ids are numbers.
  if (mono) {
    const items = edgesDS.get().map((x) => ({ id: x.id, color: { color: '#9aa0a6', opacity: 0.7 }, dashes: false }));
    edgesDS.update(items);
    await new Promise((r) => setTimeout(r, 500));
  }

  network.redraw(); await tick(); await tick();
  const batched = grab();
  const batchCount = (() => { try { return _EDGE_BATCH.count(); } catch (e) { return -1; } })();
  const batchedEdges = Object.keys(network.body.edges).filter((k) => {
    const et = network.body.edges[k].edgeType;
    return et && Object.prototype.hasOwnProperty.call(et, 'drawLine');
  }).length;

  // hand the edges back to vis without moving the camera
  let off = 'ok';
  try {
    if (typeof _EDGE_BATCH.setRest === 'function') _EDGE_BATCH.setRest(false);
    else { _REST_BATCH_ON = false; _EDGE_BATCH.set(false); }   // scratch variant
  } catch (e) { off = 'err:' + e.message; }
  network.redraw(); await tick(); await tick();
  const plain = grab();
  const plainEdges = Object.keys(network.body.edges).filter((k) => {
    const et = network.body.edges[k].edgeType;
    return et && Object.prototype.hasOwnProperty.call(et, 'drawLine');
  }).length;

  let differing = 0, worst = 0, sum = 0, painted = 0;
  const BW = 16, BH = 10;
  const bucket = new Array(BW * BH).fill(0);
  const W = cv.width, H = cv.height;
  for (let i = 0; i < batched.length; i += 4) {
    const a = batched[i] - plain[i], b = batched[i + 1] - plain[i + 1], c = batched[i + 2] - plain[i + 2];
    const d = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
    if (d > 0) sum += d;
    if (d > worst) worst = d;
    if (d > 16) {
      differing++;
      const px = (i / 4) % W, py = Math.floor((i / 4) / W);
      bucket[Math.min(BH - 1, Math.floor(py * BH / H)) * BW + Math.min(BW - 1, Math.floor(px * BW / W))]++;
    }
    if (plain[i] > 24 || plain[i + 1] > 24 || plain[i + 2] > 24) painted++;
  }
  const top = bucket.map((n, k) => ({ n, k })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 5)
    .map((x) => ({ cell: `r${Math.floor(x.k / BW)}c${x.k % BW}`, n: x.n }));

  // optional visual dump: batched frame, plain frame, and a magenta diff mask
  let dump = null;
  if (wantDump) {
    const mk = (fn) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      const img = x.createImageData(W, H);
      const d = img.data;
      for (let p = 0, i = 0; p < W * H; p++, i += 4) {
        const v = fn(i);
        d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; d[i + 3] = 255;
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
    pixels: batched.length / 4, painted, differing, worst,
    meanDiffOfDiffering: differing ? sum / differing : 0,
    pctOfPainted: painted ? (100 * differing / painted) : 0,
    top, dump,
    batchedEdges, plainEdges, off,
    batchCount,
    totalEdges: Object.keys(network.body.edges).length,
  };
}, { wantDump: DUMP, mono: MONO });

if (SHOT) await page.screenshot({ path: SHOT });
if (res.dump) {
  for (const [k, uri] of Object.entries(res.dump)) {
    fs.writeFileSync(path.join(LAB, 'shots', `L12-diff-${k}.png`), Buffer.from(uri.split(',')[1], 'base64'));
  }
  console.log('  wrote shots/L12-diff-{batched,plain,diff}.png');
}

await browser.close();
srv.close();
console.log(`${path.basename(FILE)}  camera scale=${res.camera.scale.toFixed(4)}`);
console.log(`  patched edges: batched ${res.batchedEdges} -> plain ${res.plainEdges}  (disable: ${res.off})`);
console.log(`  edges in the batch: ${res.batchCount} of ${res.totalEdges}`);console.log(`  canvas ${res.pixels} px, of which ${res.painted} non-background`);
console.log(`  pixels differing by >16: ${res.differing}  (${res.pctOfPainted.toFixed(2)}% of painted, worst channel delta ${res.worst}, mean ${res.meanDiffOfDiffering.toFixed(1)})`);
console.log('  busiest 16x10 cells: ' + res.top.map((t) => `${t.cell}=${t.n}`).join(' '));
