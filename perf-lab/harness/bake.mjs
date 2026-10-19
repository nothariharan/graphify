// Bake stabilized vis-network positions into a graph.html.
//
//   node harness/bake.mjs --file variants/base-rsl.html --out variants/rsl__v19-baked.html
//
// Loads the base in headless Chrome, waits for physics to finish, reads
// network.getPositions(), then rewrites the html so each node carries its final
// x/y and physics/improvedLayout are off. Capability (nodes/edges/communities/
// arrows/dashes) is untouched; only the on-load stabilization is moved offline.
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
const PORT = parseInt(arg('port', '8212'));
const DPR = parseFloat(arg('dpr', '1'));
if (!FILE || !OUT) { console.error('need --file and --out'); process.exit(2); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
function serve(root, port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      let p = path.join(root, u);
      if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
      fs.readFile(p, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

const srv = await serve(LAB, PORT);
const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run', '--no-default-browser-check'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: DPR });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => { if (errs.length < 6) errs.push(String(e.message).slice(0, 200)); });

const url = `http://127.0.0.1:${PORT}/` + FILE.replace(/\\/g, '/');
await page.goto(url, { waitUntil: 'load', timeout: 120000 });

// wait for the physics pass to finish (or bail after 90s)
const how = await page.evaluate(() => new Promise((res) => {
  try {
    let settled = false;
    network.once('stabilizationIterationsDone', () => { settled = true; res('stable'); });
    network.once('stabilized', () => { if (!settled) res('stabilized'); });
  } catch (e) { res('noweb'); }
  setTimeout(() => res('timeout'), 90000);
}));

const pos = await page.evaluate(() => {
  const raw = network.getPositions();
  return Object.keys(raw).map((id) => ({ id, x: +raw[id].x.toFixed(3), y: +raw[id].y.toFixed(3) }));
});
const counts = await page.evaluate(() => ({ nodes: nodesDS.length, edges: edgesDS.length }));
await browser.close();
srv.close();

if (!pos.length) { console.error('no positions captured'); process.exit(3); }

let html = fs.readFileSync(path.join(LAB, FILE), 'utf8');
const before = html.length;

// 1) turn off on-load physics + improvedLayout
const patched = html.replace(/physics: \{\r?\n(\s*)enabled: true,/, 'physics: {\n$1improvedLayout: false,\n$1enabled: false,');
if (patched === html) console.error('WARN: physics patch did not match');
html = patched;

// 2) apply baked positions right before the Network is constructed
const inject = `\n// baked positions (v19): final stabilized x/y, physics off\nconst __BAKED = ${JSON.stringify(pos)};\nnodesDS.update(__BAKED.map(o => ({ id: o.id, x: o.x, y: o.y })));\n`;
const anchor = 'const container = document.getElementById';
if (!html.includes(anchor)) { console.error('WARN: network anchor not found'); }
html = html.replace(anchor, inject + anchor);

// 3) keep the view fitted (baseline also ends fitted, so fps stays comparable)
html = html.replace('</body>', '<script>try{if(typeof network!=="undefined")network.fit({animation:false});}catch(e){}</script>\n</body>');

fs.mkdirSync(path.dirname(path.join(LAB, OUT)), { recursive: true });
fs.writeFileSync(path.join(LAB, OUT), html);
console.log(JSON.stringify({
  out: OUT, how, nodes: counts.nodes, edges: counts.edges, positions: pos.length,
  kb_before: Math.round(before / 1024), kb_after: Math.round(html.length / 1024), pageErrors: errs,
}, null, 1));
