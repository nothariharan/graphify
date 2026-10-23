// Heap-growth trace during a zoom gesture in the dense core.
//
//   node harness/probe_heap_trace.mjs --file variants/base-ours-v25.html
//
// Takes a CDP HeapProfiler snapshot before and after a deep-zoom gesture, forces GC
// in between, and reports:
//   - usedSize delta (MB) and totalSize delta
//   - the top growing (constructor, count, size) deltas
//   - the top retained (by retainer) growth for the largest new objects
// This is the "where is the heap growing" instrument the user asked for.
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
const STEPS = Number(arg('steps', '14'));
const OUT = arg('out', '');

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8299, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8299/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

// dense core
const cam = await page.evaluate(() => {
  const pos = network.getPositions();
  const ids = Object.keys(network.body.nodes);
  let best = ids[0], bestN = -1;
  for (const id of ids) {
    const p = pos[id];
    if (!p) continue;
    let n = 0;
    for (const o of ids) { const q = pos[o]; if (q && Math.hypot(q.x - p.x, q.y - p.y) < 260) n++; }
    if (n > bestN) { bestN = n; best = id; }
  }
  const c = pos[best];
  network.moveTo({ position: { x: c.x, y: c.y }, scale: network.getScale() * 8, animation: false });
  return { x: c.x, y: c.y };
});
await page.waitForTimeout(600);

const box = await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const r = cv.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(200);

const cdp = await ctx.newCDPSession(page);
await cdp.send('HeapProfiler.enable');

async function snapshot(label) {
  // force GC, then take a heap snapshot, parse the summary
  await cdp.send('HeapProfiler.collectGarbage');
  await new Promise((r) => setTimeout(r, 300));
  const chunks = [];
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (p) => chunks.push(p.chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  await new Promise((r) => setTimeout(r, 200));
  const raw = chunks.join('');
  let snap;
  try { snap = JSON.parse(raw); } catch (e) { snap = null; }
  const summary = { label, usedSize: 0, totalSize: 0, byCtor: {} };
  if (snap && snap.nodes && snap.strings) {
    // nodes: [type, name, id, self_size, edge_count, trace_node_id, ...] stride 6? Actually V8 heap snapshot node fields vary.
    // We use the snapshot's 'nodes' array with stride = snapshot.meta.node_fields.length
    const meta = snap.snapshot.meta;
    const nodeFields = meta.node_fields;
    const nodeTypes = meta.node_types[0];
    const stride = nodeFields.length;
    const typeIdx = nodeFields.indexOf('type');
    const nameIdx = nodeFields.indexOf('name');
    const selfIdx = nodeFields.indexOf('self_size');
    const nodes = snap.nodes;
    const strings = snap.strings;
    for (let i = 0; i < nodes.length; i += stride) {
      const type = nodeTypes[nodes[i + typeIdx]];
      const name = strings[nodes[i + nameIdx]];
      const self = nodes[i + selfIdx];
      summary.usedSize += self;
      const key = `${type}:${name}`;
      if (!summary.byCtor[key]) summary.byCtor[key] = { count: 0, size: 0 };
      summary.byCtor[key].count++;
      summary.byCtor[key].size += self;
    }
  }
  // also get Runtime heap usage
  const hu = await cdp.send('Runtime.getHeapUsage');
  summary.runtimeUsed = hu.usedSize;
  summary.runtimeTotal = hu.totalSize;
  return summary;
}

const before = await snapshot('before');
console.log('before: runtimeUsed', (before.runtimeUsed / 1048576).toFixed(2), 'MB, total', (before.runtimeTotal / 1048576).toFixed(2), 'MB, snapshotUsed', (before.usedSize / 1048576).toFixed(2), 'MB');

// do the gesture
const t0 = Date.now();
for (let i = 0; i < STEPS; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(45);
}
await page.waitForTimeout(500);
const wall = Date.now() - t0;

const after = await snapshot('after');
console.log('after:  runtimeUsed', (after.runtimeUsed / 1048576).toFixed(2), 'MB, total', (after.runtimeTotal / 1048576).toFixed(2), 'MB, snapshotUsed', (after.usedSize / 1048576).toFixed(2), 'MB');
console.log('delta:  runtimeUsed', ((after.runtimeUsed - before.runtimeUsed) / 1048576).toFixed(2), 'MB, total', ((after.runtimeTotal - before.runtimeTotal) / 1048576).toFixed(2), 'MB');

// top growing constructors
const keys = new Set([...Object.keys(before.byCtor), ...Object.keys(after.byCtor)]);
const deltas = [];
for (const k of keys) {
  const b = before.byCtor[k] || { count: 0, size: 0 };
  const a = after.byCtor[k] || { count: 0, size: 0 };
  const dCount = a.count - b.count;
  const dSize = a.size - b.size;
  if (dCount !== 0 || dSize !== 0) deltas.push({ ctor: k, dCount, dSize });
}
deltas.sort((x, y) => y.dSize - x.dSize);
console.log('top 20 growing constructors (by size delta):');
for (const d of deltas.slice(0, 20)) {
  console.log(`  ${d.dSize >= 0 ? '+' : ''}${(d.dSize / 1024).toFixed(1).padStart(9)} KB  count ${d.dCount >= 0 ? '+' : ''}${d.dCount}  ${d.ctor}`);
}

if (OUT) {
  fs.writeFileSync(path.join(LAB, OUT), JSON.stringify({ file: FILE, wall, before: { runtimeUsed: before.runtimeUsed, runtimeTotal: before.runtimeTotal, usedSize: before.usedSize }, after: { runtimeUsed: after.runtimeUsed, runtimeTotal: after.runtimeTotal, usedSize: after.usedSize }, deltas: deltas.slice(0, 40) }, null, 1));
}

await browser.close();
srv.close();
console.log('done, wall', wall, 'ms');
