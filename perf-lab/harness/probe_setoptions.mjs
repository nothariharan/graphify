// What does the lean lever itself cost? network.setOptions({nodes:{borderWidth}})
// makes vis re-apply options to every node and can emit _dataChanged ->
// _updateVisibleIndices + _updateValueRange(nodes) + _updateValueRange(edges).
// That is O(N)+O(E) and shows up as one big frame at dragStart/dragEnd.
//   node harness/probe_setoptions.mjs --file variants/base-continuum.html
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(8229, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8229/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(1500);

const r = await page.evaluate(() => {
  const timeIt = (fn) => { const t0 = performance.now(); fn(); return +(performance.now() - t0).toFixed(1); };
  const leanOn = [], leanOff = [];
  for (let i = 0; i < 5; i++) {
    leanOn.push(timeIt(() => network.setOptions({ nodes: { borderWidth: 0 } })));
    leanOff.push(timeIt(() => network.setOptions({ nodes: { borderWidth: 1.5 } })));
  }
  // also: a plain redraw for scale
  const redraw = [];
  for (let i = 0; i < 3; i++) {
    redraw.push(timeIt(() => { const c = document.querySelector('#graph canvas').getContext('2d'); network.redraw(); }));
  }
  return {
    nodes: nodesDS.length, edges: edgesDS.length,
    setOptions_leanOn_ms: leanOn, setOptions_leanOff_ms: leanOff,
    redraw_sync_ms: redraw,
    borderApplied: (function () { try { return network.body.nodes[nodesDS.getIds()[0]].options.borderWidth; } catch (e) { return 'n/a'; } })(),
  };
});
await browser.close();
srv.close();
console.log(JSON.stringify({ file: FILE, ...r }, null, 1));
