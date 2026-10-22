// Can a node be hidden by writing the instance (no DataSet update)?
//
// A DataSet update for 1886 nodes measured 149.6 ms, which would put a 140 ms freeze on
// every "show only this family" action. If the instance's options.hidden is honoured by
// vis's draw path, the hide becomes 1886 property writes (~1 ms).
//
//   node harness/probe_instance_hidden.mjs --file variants/base-ours-v15.html
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
await new Promise((r) => srv.listen(8278, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8278/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(async () => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const grab = () => ctx.getImageData(0, 0, cv.width, cv.height).data;
  const painted = (px) => {
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24) n++;
    return n;
  };
  const diff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 16 || Math.abs(a[i + 1] - b[i + 1]) > 16 || Math.abs(a[i + 2] - b[i + 2]) > 16) n++;
    }
    return n;
  };
  const r = {};
  network.redraw(); await wait(300);
  const base = grab();
  r.paintedBefore = painted(base);

  // 1) instance write: options.hidden on the nodes of one community
  const ids = Object.keys(network.body.nodes);
  const target = ids.slice(0, 200);
  const t0 = performance.now();
  for (const id of target) network.body.nodes[id].options.hidden = true;
  r.instanceWriteMs = +(performance.now() - t0).toFixed(1);
  network.redraw(); await wait(300);
  const after = grab();
  r.pixelsChanged = diff(base, after);
  r.paintedAfter = painted(after);

  // 2) the same through the DataSet, for the cost comparison
  const t1 = performance.now();
  nodesDS.update(target.map((id) => ({ id, hidden: true })));
  r.dataSetUpdateMs = +(performance.now() - t1).toFixed(1);
  network.redraw(); await wait(300);
  const after2 = grab();
  r.pixelsChangedAfterDataSet = diff(after, after2);
  r.paintedAfterDataSet = painted(after2);
  return r;
});
console.log(path.basename(FILE));
console.log(JSON.stringify(out, null, 1));
await browser.close();
srv.close();
