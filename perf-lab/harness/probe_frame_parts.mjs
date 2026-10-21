// Where does the resting frame go? The node pass is the last big cost (L9: no safe seam,
// and the edges are now batched), so measure the split before trying to move it.
//
//   node harness/probe_frame_parts.mjs --file variants/base-ours-v10.html
//
// Configs, each measured over the same number of forced redraws:
//   normal        - the shipped frame
//   no-nodes      - every node's shape.draw stubbed out (no dots, no borders)
//   no-edges      - the edge batch uninstalled, vis draws 3876 edges one by one
//   no-nodes-edges- both
// The remainder is the frame's fixed cost (clear, node labels, hit boxes, vis bookkeeping).
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
const FRAMES = Number(arg('frames', '12'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8263, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8263/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async (frames) => {
  const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
  const nodes = network.body.nodes;
  const shapes = [];
  for (const id in nodes) {
    const n = nodes[id];
    if (n && n.shape && typeof n.shape.draw === 'function') { shapes.push([n.shape, n.shape.draw]); }
  }
  const setShapes = (on) => {
    for (const [shape, fn] of shapes) shape.draw = on ? fn : function () {};
  };
  const setRest = (on) => { try { _EDGE_BATCH.setRest(on); } catch (e) {} };

  async function measure(label, setup) {
    setup();
    await tick(); await tick();
    const samples = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      network.redraw();
      await tick();
      samples.push(performance.now() - t0);
    }
    const s = samples.slice(1).sort((a, b) => a - b);
    return { label, median: +s[Math.floor(s.length / 2)].toFixed(1), min: +s[0].toFixed(1), max: +s[s.length - 1].toFixed(1) };
  }

  const res = [];
  res.push(await measure('normal', () => { setShapes(true); setRest(true); }));
  res.push(await measure('no-nodes', () => { setShapes(false); setRest(true); }));
  res.push(await measure('no-edges', () => { setShapes(true); setRest(false); }));
  res.push(await measure('no-nodes-edges', () => { setShapes(false); setRest(false); }));
  // restore, so the page is left as it was
  setShapes(true); setRest(true);
  return { res, shapes: shapes.length };
}, FRAMES);

console.log(`${path.basename(FILE)}  node shapes patched: ${out.shapes}`);
for (const r of out.res) console.log(`  ${r.label.padEnd(15)} median ${String(r.median).padStart(6)} ms   min ${r.min}  max ${r.max}`);
await browser.close();
srv.close();
