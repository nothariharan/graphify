// Probe a graph html: viewport + what's actually on screen.
//   node harness/probe.mjs --file variants/base-rsl.html
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
const FILE = arg('file'); const PORT = parseInt(arg('port', '8214'));

function serve(root, port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      let p = path.join(root, u);
      fs.readFile(p, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'content-type': path.extname(p) === '.html' ? 'text/html' : 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

const srv = await serve(LAB, PORT);
const browser = await chromium.launch({ executablePath: CHROME, headless: true,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-features=CalculateNativeWinOcclusion'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${PORT}/` + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.evaluate(() => new Promise(r => { try { network.once('stabilizationIterationsDone', () => r(1)); } catch (e) { r(0); } setTimeout(() => r(1), 30000); }));
await new Promise(r => setTimeout(r, 1500));
const info = await page.evaluate(() => {
  const pos = network.getViewPosition(); const sc = network.getScale();
  const canvas = document.querySelector('#graph canvas');
  const rect = canvas.getBoundingClientRect();
  const w2 = rect.width / 2 / sc, h2 = rect.height / 2 / sc;
  let vis = 0;
  for (const id of Object.keys(nodesDS._data)) {
    const p = network.getPositions([id])[id];
    if (p && Math.abs(p.x - pos.x) < w2 && Math.abs(p.y - pos.y) < h2) vis++;
  }
  return { scale: +sc.toFixed(3), view: { x: Math.round(pos.x), y: Math.round(pos.y) }, visible_in_view: vis, total: nodesDS.length };
});
await browser.close(); srv.close();
console.log(JSON.stringify(info));
