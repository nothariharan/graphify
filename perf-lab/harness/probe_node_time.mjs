// The frame is 86 ms, stubbing the node shapes takes it to 23 ms, but replaying the same
// 1886 dots on the same canvas costs 2.4 ms. So where are the 63 ms?
//
// This wraps the per-node draw functions and accumulates the time spent inside them:
//
//   node.draw   - vis's per-node draw (calls the shape, then the label)
//   shape.draw  - the dot itself (fill + border stroke)
//
// If the time is inside shape.draw it is vis's draw path; if it is outside both, it is
// the browser presenting the frame.
//
//   node harness/probe_node_time.mjs --file variants/base-ours-v10.html
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

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8268, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8268/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const tick = () => new Promise((r) => requestAnimationFrame(() => r()));
  const nodes = network.body.nodes;
  const acc = { nodeDraw: 0, shapeDraw: 0, calls: 0 };
  for (const id in nodes) {
    const n = nodes[id];
    if (!n) continue;
    if (n.shape && typeof n.shape.draw === 'function') {
      const orig = n.shape.draw;
      n.shape.draw = function (...a) {
        const t0 = performance.now();
        const r = orig.apply(this, a);
        acc.shapeDraw += performance.now() - t0;
        return r;
      };
    }
    if (typeof n.draw === 'function') {
      const orig = n.draw;
      n.draw = function (...a) {
        const t0 = performance.now();
        const r = orig.apply(this, a);
        acc.nodeDraw += performance.now() - t0;
        acc.calls++;
        return r;
      };
    }
  }

  const samples = [];
  for (let i = 0; i < 10; i++) {
    acc.nodeDraw = 0; acc.shapeDraw = 0; acc.calls = 0;
    const t0 = performance.now();
    network.redraw();
    await tick();
    samples.push({
      frame: +(performance.now() - t0).toFixed(1),
      nodeDraw: +acc.nodeDraw.toFixed(1),
      shapeDraw: +acc.shapeDraw.toFixed(1),
      calls: acc.calls,
    });
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  return {
    frame: med(samples.map((s) => s.frame)),
    nodeDraw: med(samples.map((s) => s.nodeDraw)),
    shapeDraw: med(samples.map((s) => s.shapeDraw)),
    calls: med(samples.map((s) => s.calls)),
  };
});

console.log(`${path.basename(FILE)}`);
console.log(`  frame            ${out.frame} ms`);
console.log(`  inside node.draw  ${out.nodeDraw} ms  (${out.calls} nodes)`);
console.log(`  inside shape.draw ${out.shapeDraw} ms`);
console.log(`  outside both      ${(out.frame - out.nodeDraw).toFixed(1)} ms`);
await browser.close();
srv.close();
