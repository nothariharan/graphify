// What colour are the edges actually drawn with, per theme, and how visible are they?
//
//   node harness/probe_edge_color.mjs --file variants/base-ours-v14.html --theme light
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
const THEME = arg('theme', 'light');

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8277, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((t) => { try { localStorage.setItem('graphify-theme', t); } catch (e) {} }, THEME);
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8277/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const ids = Object.keys(network.body.edges);
  const e = network.body.edges[ids[0]];
  const t = e.getFormattingValues();
  const probe = document.createElement('canvas').getContext('2d');
  const resolved = e.edgeType.getColor(probe, t);
  const nodes = network.body.nodes;
  const nids = Object.keys(nodes);
  const n = nodes[nids[0]];
  const nc = n.options.color;
  // how dark is the drawn edge? sample the canvas along a long edge
  const cv = document.querySelector('#graph canvas');
  const c2 = cv.getContext('2d');
  let samples = [];
  for (const id of ids.slice(0, 40)) {
    const ed = network.body.edges[id];
    const a = ed.fromPoint, b = ed.toPoint;
    if (!a || !b) continue;
    const x = Math.round(cv.width / 2 + (a.x - b.x) * 0.5 * network.getScale());
    const y = Math.round(cv.height / 2 + (a.y - b.y) * 0.5 * network.getScale());
    if (x < 1 || y < 1 || x >= cv.width - 1 || y >= cv.height - 1) continue;
    const d = c2.getImageData(x, y, 1, 1).data;
    samples.push([d[0], d[1], d[2]]);
  }
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  return {
    edgeOptionsColor: e.options.color,
    edgeFormattingColor: t.color,
    edgeOpacity: t.opacity,
    edgeWidth: t.width,
    edgeResolved: resolved,
    nodeColour: { bg: nc.background, border: nc.border, highlight: nc.highlight, hover: nc.hover },
    bg,
    samples: samples.slice(0, 12),
    scale: network.getScale(),
  };
});
console.log(path.basename(FILE), "theme", THEME);
console.log(JSON.stringify(out, null, 1));
await browser.close();
srv.close();
