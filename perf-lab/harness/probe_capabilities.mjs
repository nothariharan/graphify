// Capability + cache-invalidation check for the at-rest edge batch (L12).
//
// The batch caches one stroke per (colour, dashes, width) group, so the questions that
// matter are:
//   1. an arrowhead still appears on hover            (arrowed edges go through vis)
//   2. a selected edge still paints its highlight     (selected edges go through vis)
//   3. a data change reaches the canvas              (cached groups are rebuilt)
//
// (3) is the dangerous one, so it is measured against a ground truth: hide a community with
// the batch OFF, then hide it again with the batch ON. If the cache went stale the second
// frame would still stroke the hidden edges and the two frames would disagree.
//
//   node harness/probe_capabilities.mjs --file variants/base-ours-v9.html --shot shots/L12-arrow.png
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
const NODASH = arg('nodash', '0') === '1';

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8245, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
await page.goto('http://127.0.0.1:8245/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2600);

const res = await page.evaluate(async ({ wantDump, nodash }) => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  const grab = () => Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data);
  const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
  const snap = async () => { network.redraw(); await tick(); await tick(); return grab(); };
  const diff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 16) n++;
    }
    return n;
  };
  const painted = (a) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] > 24 || a[i + 1] > 24 || a[i + 2] > 24) n++; return n; };
  const out = {};

  // A fresh page's first two idle frames are not the settled frame: one delayed pass
  // (~40k px) changes the picture on the third draw, after which it is stable. Take six
  // snaps and use the last, recording that the last two agree.
  const shots = [];
  for (let i = 0; i < 6; i++) {
    shots.push(await snap());
    await new Promise((r) => setTimeout(r, 300));
  }
  const base = shots[5];
  out.settle = { lastTwoDiffer: diff(shots[4], shots[5]), firstVsLast: diff(shots[0], base) };
  out.canvas = `${cv.width}x${cv.height}`;

  // the longest on-screen edge: easiest to see, and it has an arrowhead to reveal
  let bestEdge = null, bl = -1;
  for (const id in network.body.edges) {
    const e = network.body.edges[id];
    if (!e || !e.edgeType) continue;
    const l = Math.hypot(e.edgeType.toPoint.x - e.edgeType.fromPoint.x, e.edgeType.toPoint.y - e.edgeType.fromPoint.y);
    if (l > bl) { bl = l; bestEdge = e; }
  }
  const eid = bestEdge ? bestEdge.id : null;

  // 1. arrowhead reveal on hover
  network.emit('hoverEdge', { edge: eid });
  await new Promise((r) => setTimeout(r, 350));
  const he = (eid !== null && network.body.edges[eid]) || bestEdge;
  const et = he && he.edgeType;
  const a = et && et.options && et.options.arrows;
  out.arrow = {
    enabled: !!(a && a.to && a.to.enabled === true),
    patched: !!(et && et.__leanBatch),
    edge: String(eid),
    changedPixels: diff(base, await snap()),
  };
  network.emit('blurEdge', { edge: eid });
  await new Promise((r) => setTimeout(r, 350));

  // 2. a selected edge still paints its highlight, and deselecting restores the frame
  try { network.selectEdges([eid]); } catch (e) { out.selectError = String(e.message); }
  await new Promise((r) => setTimeout(r, 350));
  out.selectedPixels = diff(base, await snap());
  try { network.unselectAll(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 350));
  out.afterDeselectPixels = diff(base, await snap());

  // 3. cache invalidation, ground truth: hide a community with the batch off and on
  const community = (() => {
    const counts = {};
    for (const n of nodesDS.get()) counts[n.community] = (counts[n.community] || 0) + 1;
    let best = null, bn = -1;
    for (const k in counts) if (counts[k] > bn) { bn = counts[k]; best = k; }
    return { id: best, n: bn };
  })();
  const hide = (on) => nodesDS.update(nodesDS.get().filter((n) => String(n.community) === String(community.id))
    .map((n) => ({ id: n.id, hidden: on })));

  // 3a. control: the same comparison in the settled state, to separate "the hidden state
  // does something odd" from "this harness measures differently".
  const pctOf = (n, a) => +(100 * n / Math.max(1, painted(a))).toFixed(2);
  if (nodash) {
    edgesDS.update(edgesDS.get().map((x) => ({ id: x.id, dashes: false })));
    await new Promise((r) => setTimeout(r, 500));
  }
  if (typeof _EDGE_BATCH.setRest === 'function') _EDGE_BATCH.setRest(false);
  await new Promise((r) => setTimeout(r, 350));
  const plainBase = await snap();
  if (typeof _EDGE_BATCH.setRest === 'function') _EDGE_BATCH.setRest(true);
  await new Promise((r) => setTimeout(r, 350));
  const batchBase = await snap();
  out.settledParity = { differing: diff(plainBase, batchBase), pctOfPainted: pctOf(diff(plainBase, batchBase), plainBase) };
  {
    let ob = 0, op = 0;
    for (let i = 0; i < plainBase.length; i += 4) {
      const dp = plainBase[i] > 24 || plainBase[i + 1] > 24 || plainBase[i + 2] > 24;
      const db = batchBase[i] > 24 || batchBase[i + 1] > 24 || batchBase[i + 2] > 24;
      if (db && !dp) ob++; else if (dp && !db) op++;
    }
    out.settledParity.paintedPlain = painted(plainBase);
    out.settledParity.paintedBatch = painted(batchBase);
    out.settledParity.onlyBatch = ob;
    out.settledParity.onlyPlain = op;
  }

  // 3b. hide a community with the batch ON, then with it OFF
  hide(true);
  await new Promise((r) => setTimeout(r, 350));
  const batchHidden = await snap();

  if (typeof _EDGE_BATCH.setRest === 'function') _EDGE_BATCH.setRest(false);
  await new Promise((r) => setTimeout(r, 350));
  const plainHidden = await snap();

  out.community = community;
  out.hiddenVsPlain = { differing: diff(plainHidden, batchHidden), pctOfPainted: 0 };
  out.hiddenVsPlain.pctOfPainted = +(100 * out.hiddenVsPlain.differing / Math.max(1, painted(plainHidden))).toFixed(2);
  // which side paints more? a whole edge missing on one side shows up here
  let onlyBatch = 0, onlyPlain = 0;
  for (let i = 0; i < plainHidden.length; i += 4) {
    const dp = plainHidden[i] > 24 || plainHidden[i + 1] > 24 || plainHidden[i + 2] > 24;
    const db = batchHidden[i] > 24 || batchHidden[i + 1] > 24 || batchHidden[i + 2] > 24;
    if (db && !dp) onlyBatch++;
    else if (dp && !db) onlyPlain++;
  }
  out.hiddenVsPlain.onlyBatch = onlyBatch;
  out.hiddenVsPlain.onlyPlain = onlyPlain;

  // crop the busiest region of the settled-state diff, to look at what actually moved
  if (wantDump) {
    const BW = 16, BH = 10, W = cv.width, H = cv.height;
    const buckets = new Array(BW * BH).fill(0);
    for (let i = 0; i < plainBase.length; i += 4) {
      if (Math.max(Math.abs(plainBase[i] - batchBase[i]), Math.abs(plainBase[i + 1] - batchBase[i + 1]), Math.abs(plainBase[i + 2] - batchBase[i + 2])) <= 16) continue;
      const p = i / 4, px = p % W, py = Math.floor(p / W);
      buckets[Math.min(BH - 1, Math.floor(py * BH / H)) * BW + Math.min(BW - 1, Math.floor(px * BW / W))]++;
    }
    let bk = 0;
    for (let k = 1; k < buckets.length; k++) if (buckets[k] > buckets[bk]) bk = k;
    const cx = Math.max(0, Math.min(W - 250, Math.floor(((bk % BW) + 0.5) * W / BW) - 125));
    const cy = Math.max(0, Math.min(H - 200, Math.floor((Math.floor(bk / BW) + 0.5) * H / BH) - 100));
    const crop = (src, mask) => {
      const c = document.createElement('canvas'); c.width = 250; c.height = 200;
      const x = c.getContext('2d'); const img = x.createImageData(250, 200);
      for (let yy = 0; yy < 200; yy++) for (let xx = 0; xx < 250; xx++) {
        const si = ((cy + yy) * W + (cx + xx)) * 4, di = (yy * 250 + xx) * 4;
        if (mask) {
          const a = plainBase[si], b = batchBase[si];
          const d = Math.max(Math.abs(a - b), Math.abs(plainBase[si + 1] - batchBase[si + 1]), Math.abs(plainBase[si + 2] - batchBase[si + 2]));
          const v = d > 16 ? [255, 0, 255] : [a >> 2, plainBase[si + 1] >> 2, plainBase[si + 2] >> 2];
          img.data[di] = v[0]; img.data[di + 1] = v[1]; img.data[di + 2] = v[2]; img.data[di + 3] = 255;
        } else {
          img.data[di] = src[si]; img.data[di + 1] = src[si + 1]; img.data[di + 2] = src[si + 2]; img.data[di + 3] = 255;
        }
      }
      x.putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    };
    out.dump = { plain: crop(plainBase, false), batch: crop(batchBase, false), mask: crop(null, true) };
    out.dumpCrop = { x: cx, y: cy };
  }
  out.hiddenChangedFromBase = diff(base, batchHidden);

  hide(false);
  await new Promise((r) => setTimeout(r, 350));
  out.restoredPixels = diff(base, await snap());
  out.nodesVisible = nodesDS.get().filter((n) => !n.hidden).length;

  out.patchedInstances = (() => {
    try { return Object.keys(network.body.edges).filter((k) => network.body.edges[k].edgeType.__leanBatch).length; }
    catch (e) { return -1; }
  })();
  return out;
}, { wantDump: DUMP, nodash: NODASH });

if (SHOT) await page.screenshot({ path: SHOT });
if (res.dump) {
  for (const [k, uri] of Object.entries(res.dump)) {
    fs.writeFileSync(path.join(LAB, 'shots', `L12-settled-${k}.png`), Buffer.from(uri.split(',')[1], 'base64'));
  }
  console.log(`  crop at x=${res.dumpCrop.x} y=${res.dumpCrop.y}: shots/L12-settled-{plain,batch,mask}.png`);
}
await browser.close();
srv.close();

console.log(`${path.basename(FILE)}  canvas ${res.canvas}; scene settled: last two snaps differ by ${res.settle.lastTwoDiffer} px (first vs last ${res.settle.firstVsLast}); patched edge instances ${res.patchedInstances}`);
console.log(`  arrowhead on the hovered edge: enabled=${res.arrow.enabled} batchedInstance=${res.arrow.patched} -> ${res.arrow.changedPixels} px changed`);
console.log(`  selected edge: ${res.selectedPixels} px changed, ${res.afterDeselectPixels} px still different after deselect`);
console.log(`  control, settled state: batch ON vs OFF ${res.settledParity.differing} px (${res.settledParity.pctOfPainted}% of painted; only-batch ${res.settledParity.onlyBatch}, only-plain ${res.settledParity.onlyPlain}; painted ${res.settledParity.paintedBatch} vs ${res.settledParity.paintedPlain})`);
console.log(`  hid community ${res.community.id} (${res.community.n} nodes): ${res.hiddenChangedFromBase} px changed;`);
console.log(`    batch ON vs batch OFF on that frame: ${res.hiddenVsPlain.differing} px (${res.hiddenVsPlain.pctOfPainted}% of painted; only-batch ${res.hiddenVsPlain.onlyBatch}, only-plain ${res.hiddenVsPlain.onlyPlain})`);
console.log(`  restored: ${res.restoredPixels} px still different vs the settled frame (${res.nodesVisible} nodes visible)`);
if (res.selectError) console.log('  selectError: ' + res.selectError);
if (errs.length) console.log('  page errors: ' + errs.join('; '));
