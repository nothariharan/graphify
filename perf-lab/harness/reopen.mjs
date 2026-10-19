// Prove the stabilized-layout cache: first open pays the solver, second open
// (same origin/storage) skips it.
//   node harness/reopen.mjs --file variants/rsl__v30-newdefault.html
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
const FILE = arg('file'); const PORT = parseInt(arg('port', '8215'));

function serve(root, port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const p = path.join(root, u);
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
const errs = [];
page.on('pageerror', e => { if (errs.length < 4) errs.push(String(e.message).slice(0, 160)); });
const url = `http://127.0.0.1:${PORT}/` + FILE.replace(/\\/g, '/');
const POSK_EXPR = "(() => { try { return 'graphify-pos:' + RAW_NODES.length + ':' + String(RAW_NODES[0].id) + ':' + String(RAW_NODES[RAW_NODES.length-1].id); } catch(e){ return null; } })()";

async function load() {
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const t = Date.now();
  await page.waitForFunction(() => {
    try { return typeof network !== 'undefined' && network.physics && network.physics.options.enabled === false; } catch (e) { return false; }
  }, { timeout: 120000 });
  const ms = Date.now() - t;
  const info = await page.evaluate((e) => {
    let cached = null;
    try { cached = !!localStorage.getItem(eval(e)); } catch (err) { cached = 'n/a'; }
    return { cached, nodes: nodesDS.length };
  }, POSK_EXPR);
  return { ms_to_physics_off: ms, ...info };
}

const first = await load();
const second = await load();
await browser.close(); srv.close();
console.log(JSON.stringify({ file: FILE, first, second, pageErrors: errs }, null, 1));
