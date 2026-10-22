// The families panel: does the community list exist, do the filters work, and what do they
// cost?
//
//   node harness/probe_families.mjs --file variants/base-ours-v15.html
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
const SHOT = arg('shot', '');

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8279, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
await page.goto('http://127.0.0.1:8279/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const r = {};
  const rows = document.querySelectorAll('.legend-item');
  r.rows = rows.length;
  r.swatchCount = document.querySelectorAll('.colour-swatch').length;
  r.firstRow = rows.length ? rows[0].textContent.replace(/\s+/g, ' ').trim() : null;
  r.visibleNodes = () => {
    let n = 0;
    for (const id in network.body.nodes) {
      const nd = network.body.nodes[id];
      if (nd && nd.options && nd.options.hidden !== true) n++;
    }
    return n;
  };
  r.visibleBefore = r.visibleNodes();
  return r;
});

const time = async (fn) => {
  const t0 = Date.now();
  await fn();
  await page.waitForTimeout(250);
  return Date.now() - t0;
};

// 1) click a family name -> isolate it
out.isolateMs = await time(async () => {
  await page.click('.legend-item .legend-label');
});
out.afterIsolate = await page.evaluate(() => {
  let n = 0;
  for (const id in network.body.nodes) {
    const nd = network.body.nodes[id];
    if (nd && nd.options && nd.options.hidden !== true) n++;
  }
  return n;
});
out.dimmedRows = await page.evaluate(() => document.querySelectorAll('.legend-item.dimmed').length);

// 2) click it again -> everything back
out.unisolateMs = await time(async () => {
  await page.click('.legend-item .legend-label');
});
out.afterUnisolate = await page.evaluate(() => {
  let n = 0;
  for (const id in network.body.nodes) {
    const nd = network.body.nodes[id];
    if (nd && nd.options && nd.options.hidden !== true) n++;
  }
  return n;
});

// 3) a colour swatch -> that colour only
out.colourMs = await time(async () => {
  await page.click('.colour-swatch');
});
out.afterColour = await page.evaluate(() => {
  let n = 0;
  for (const id in network.body.nodes) {
    const nd = network.body.nodes[id];
    if (nd && nd.options && nd.options.hidden !== true) n++;
  }
  return n;
});

// 4) the "All" checkbox -> everything back
out.allMs = await time(async () => {
  await page.click('#select-all-cb');
});
out.afterAll = await page.evaluate(() => {
  let n = 0;
  for (const id in network.body.nodes) {
    const nd = network.body.nodes[id];
    if (nd && nd.options && nd.options.hidden !== true) n++;
  }
  return n;
});

// 5) the family filter box
await page.fill('#family-filter', 'frontend');
await page.waitForTimeout(200);
out.filteredRows = await page.evaluate(() => document.querySelectorAll('.legend-item').length);
await page.fill('#family-filter', '');
await page.waitForTimeout(200);
out.rowsAfterClear = await page.evaluate(() => document.querySelectorAll('.legend-item').length);

// The worst single frame during the action: a bulk filter is a deliberate action, but a
// 280 ms block is still a freeze.
await page.evaluate(() => {
  window.__gaps = [];
  let last = performance.now();
  const tick = (t) => {
    window.__gaps.push(t - last);
    last = t;
    window.__raf = requestAnimationFrame(tick);
  };
  window.__raf = requestAnimationFrame(tick);
});
const worstFrame = async (fn) => {
  await page.evaluate(() => { window.__gaps.length = 0; });
  const t0 = Date.now();
  await fn();
  await page.waitForTimeout(400);
  const total = Date.now() - t0;
  const gaps = await page.evaluate(() => {
    const g = window.__gaps.slice().sort((a, b) => b - a);
    return { max: Math.round(g[0] || 0), p95: Math.round(g[Math.floor(g.length * 0.05)] || 0) };
  });
  return { total, ...gaps };
};

out.isolateFrame = await worstFrame(async () => { await page.click('.legend-item .legend-label'); });
out.unisolateFrame = await worstFrame(async () => { await page.click('.legend-item .legend-label'); });
out.colourFrame = await worstFrame(async () => { await page.click('.colour-swatch'); });
out.allFrame = await worstFrame(async () => { await page.click('#select-all-cb'); });

if (SHOT) await page.screenshot({ path: path.join(LAB, SHOT) });
console.log(path.basename(FILE));
console.log(`  family rows ${out.rows}, colour swatches ${out.swatchCount}, first row "${out.firstRow}"`);
console.log(`  visible nodes: ${out.visibleBefore} -> isolate ${out.afterIsolate} (${out.dimmedRows} rows dimmed)`);
console.log(`  un-isolate -> ${out.afterUnisolate}`);
console.log(`  colour filter -> ${out.afterColour}`);
console.log(`  show all -> ${out.afterAll}`);
console.log(`  worst frame: isolate ${out.isolateFrame.max} ms, un-isolate ${out.unisolateFrame.max} ms, colour ${out.colourFrame.max} ms, all ${out.allFrame.max} ms`);
console.log(`  filter "frontend" -> ${out.filteredRows} rows, cleared -> ${out.rowsAfterClear}`);
if (errors.length) console.log('  errors: ' + errors.slice(0, 3).join(' | '));

await browser.close();
srv.close();
