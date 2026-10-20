// Screenshot a graph page at its fitted view, after the solver is done.
//   node harness/shot_fit.mjs --file variants/v8-it30.html --out shots/it30.png
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
const OUT = arg('out');
const W = parseInt(arg('w', '1280'));
const H = parseInt(arg('h', '800'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto('http://127.0.0.1:' + port + '/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => typeof network !== 'undefined' && network.body && network.body.nodes && Object.keys(network.body.nodes).length > 0, null, { timeout: 180000 });
await page.waitForTimeout(2500);
const info = await page.evaluate(() => ({ scale: network.getScale(), nodes: Object.keys(network.body.nodes).length }));
await page.screenshot({ path: path.join(LAB, OUT) });
await browser.close();
srv.close();
console.log(JSON.stringify({ file: FILE, out: OUT, ...info }));
process.exit(0);
