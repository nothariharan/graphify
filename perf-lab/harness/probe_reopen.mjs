// Why is our page faster to open than the official one? The official build has no layout
// cache, so every open runs vis's 200-iteration solver in the browser. Ours caches the
// stabilized positions in localStorage, so a RE-OPEN of the same graph in the same browser
// skips the solver entirely.
//
// This opens the same page twice in the same browser context and reports both.
//
//   node harness/probe_reopen.mjs --file variants/base-ours-v13.html
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
const RUNS = Number(arg('runs', '3'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8276, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run', '--no-default-browser-check'],
});
// one context for every run: the point is the localStorage cache surviving between opens
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const times = [];
for (let i = 0; i < RUNS; i++) {
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:8276/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => {
    try {
      return typeof network !== 'undefined' && network.body &&
        Object.keys(network.body.nodes).length > 0 && network.physics.options.enabled === false;
    } catch (e) { return false; }
  }, null, { timeout: 180000 });
  const ready = Date.now() - t0;
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {};
    return { dcl: Math.round(n.domContentLoadedEventEnd || 0) };
  });
  const cached = await page.evaluate(() => {
    try { return Object.keys(localStorage).filter((k) => k.indexOf('graphify-pos') === 0).length; } catch (e) { return -1; }
  });
  times.push({ ready, dcl: nav.dcl, cached });
  console.log(`  open ${i + 1}: ready ${ready} ms   dcl ${nav.dcl} ms   layout cache entries ${cached}`);
  await page.close();
}
await browser.close();
srv.close();
console.log(`${path.basename(FILE)}  first open ${times[0].ready} ms -> re-open ${times[times.length - 1].ready} ms` +
  `  (saved ${times[0].ready - times[times.length - 1].ready} ms)`);
