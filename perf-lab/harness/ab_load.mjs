// Interleaved first-open load A/B/C. Each variant gets a FRESH browser context (so the
// localStorage layout cache is cold), is loaded once, and is timed until the network is
// live and physics is off (the moment the graph stops solving). Rounds are odd and the
// variant order rotates every round, because this host drifts between batches.
//
//   node harness/ab_load.mjs --variants "v8=variants/v8-obsidian.html,it60=variants/v8-it60.html" \
//        --rounds 5 --out results/ab-load-iters.csv
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
const VARIANTS = arg('variants').split(',').map((x) => {
  const [name, file] = x.split('=');
  return { name: name.trim(), file: file.trim() };
});
const ROUNDS = parseInt(arg('rounds', '5'));
const OUT = arg('out', 'results/ab-load.csv');
if (!VARIANTS.length) { console.error('need --variants'); process.exit(2); }

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise(r => srv.listen(8240, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run', '--no-default-browser-check'],
});

async function once(file) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:8240/' + file, { waitUntil: 'load', timeout: 180000 });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {};
    return { dcl: Math.round(n.domContentLoadedEventEnd || 0), load: Math.round(n.loadEventEnd || 0) };
  });
  await page.waitForFunction(() => {
    try {
      return typeof network !== 'undefined' && network.body && network.body.nodes &&
        Object.keys(network.body.nodes).length > 0 && network.physics.options.enabled === false;
    } catch (e) { return false; }
  }, null, { timeout: 180000 });
  const ready = Date.now() - t0;
  const info = await page.evaluate(() => ({
    nodes: nodesDS.length,
    edges: edgesDS.length,
    solved: (() => { try { return network.physics.options.enabled; } catch (e) { return null; } })(),
  }));
  await ctx.close();
  return { ready, dcl: nav.dcl, load: nav.load, ...info, errs };
}

const rows = [];
for (let r = 1; r <= ROUNDS; r++) {
  const order = VARIANTS.slice();
  const shift = (r - 1) % order.length;
  const rotated = order.slice(shift).concat(order.slice(0, shift));
  for (const v of rotated) {
    let m;
    try { m = await once(v.file); } catch (e) { m = { ready: null, error: String(e.message).slice(0, 160) }; }
    rows.push({ round: r, variant: v.name, ...m });
    console.log(`round ${r}  ${v.name.padEnd(12)} ready=${m.ready}  dcl=${m.dcl}  load=${m.load}${m.error ? '  ERR ' + m.error : ''}`);
  }
}

await browser.close();
srv.close();

const med = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)] : null; };
const names = VARIANTS.map((v) => v.name);
const summary = names.map((n) => {
  const rs = rows.filter((x) => x.variant === n);
  return { variant: n, ready_med: med(rs.map((x) => x.ready)), dcl_med: med(rs.map((x) => x.dcl)), load_med: med(rs.map((x) => x.load)), runs: rs.length };
});

const cols = ['round', 'variant', 'ready', 'dcl', 'load', 'nodes', 'edges', 'error'];
fs.mkdirSync(path.dirname(path.join(LAB, OUT)), { recursive: true });
const p = path.join(LAB, OUT);
fs.writeFileSync(p, cols.join(',') + '\n' + rows.map((r) => cols.map((c) => {
  const v = String(r[c] ?? '');
  return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}).join(',')).join('\n') + '\n');

console.log('\nmedians (ms):');
for (const s of summary) {
  const base = summary[0].ready_med;
  const ratio = s.ready_med && base ? 'x' + (s.ready_med / base).toFixed(2) : '';
  console.log(`  ${s.variant.padEnd(12)} ready=${String(s.ready_med).padStart(5)} ${ratio.padStart(6)}   dcl=${s.dcl_med}  load=${s.load_med}`);
}
console.log('\ncsv: ' + p);
