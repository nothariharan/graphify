// How many consecutive same-colour runs are there in vis's own draw order?
//
//   node harness/probe_runs.mjs --file variants/base-ours-v10.html
//
// The rest batch draws edges grouped by colour, which reorders the strokes: where two
// translucent edges cross, a different one ends up on top (10.22% of painted pixels
// differ in colour, coverage identical). If the edges arrive in long same-colour runs,
// the batch could group *runs* instead of colour classes and keep vis's order exactly.
// This probe counts the runs so the idea is measured before it is built.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const FILE = arg('file');

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8261, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8261/' + FILE, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2000);

const out = await page.evaluate(() => {
  const probe = document.createElement('canvas').getContext('2d');
  const es = network.body.edges;
  const keys = [];
  let solid = 0, dashed = 0, skipped = 0;
  for (const id in es) {
    const e = es[id];
    if (!e || !e.connected || !e.edgeType) { skipped++; continue; }
    const fo = e.from && e.from.options, to = e.to && e.to.options;
    if ((e.options && e.options.hidden) || (fo && fo.hidden) || (to && to.hidden)) { skipped++; continue; }
    const t = e.getFormattingValues();
    if (!t || t.hidden) { skipped++; continue; }
    const d = t.dashes;
    if (d && d !== false) { dashed++; continue; }
    const col = e.edgeType.getColor(probe, t);
    if (typeof col !== 'string') { skipped++; continue; }
    solid++;
    keys.push(col + '|' + ((e.options && typeof e.options.width === 'number') ? e.options.width : t.width));
  }
  // runs of equal consecutive keys
  let runs = 0;
  for (let i = 0; i < keys.length; i++) if (i === 0 || keys[i] !== keys[i - 1]) runs++;
  const distinct = new Set(keys).size;
  // run length distribution
  const lens = [];
  let cur = 1;
  for (let i = 1; i < keys.length; i++) {
    if (keys[i] === keys[i - 1]) cur++; else { lens.push(cur); cur = 1; }
  }
  if (keys.length) lens.push(cur);
  lens.sort((a, b) => a - b);
  const q = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
  return {
    total: Object.keys(es).length, solid, dashed, skipped,
    distinctGroups: distinct, runs,
    runLenMedian: q(0.5), runLenP90: q(0.9), runLenMax: lens[lens.length - 1],
    singletonRuns: lens.filter((x) => x === 1).length,
  };
});

console.log(`${FILE}`);
console.log(`  edges ${out.total}: solid ${out.solid}, dashed ${out.dashed}, skipped ${out.skipped}`);
console.log(`  colour groups (what the batch draws now): ${out.distinctGroups} strokes`);
console.log(`  consecutive runs in vis draw order      : ${out.runs} strokes  (median run ${out.runLenMedian}, p90 ${out.runLenP90}, max ${out.runLenMax}, singletons ${out.singletonRuns})`);
console.log(out.runs <= out.distinctGroups * 3
  ? '  -> run batching is viable: same order as vis, few strokes'
  : '  -> run batching is NOT viable: the order alternates too much');

await browser.close();
srv.close();
