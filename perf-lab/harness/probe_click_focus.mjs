// Does clicking a node dim everything that is not connected to it, and does clicking
// away put the picture back exactly?
//
//   node harness/probe_click_focus.mjs --file variants/base-ours-v13.html
//
// Synthetic network.emit('click') does not set vis's selection, so the click goes through
// the real mouse (the node is moved to the centre of the canvas first). The frame
// snapshots stay in the page: returning 3 MB of pixels over CDP is not worth it.
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
const SCALE = parseFloat(arg('scale', '1.2'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8275, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const THEME = arg('theme', '');
if (THEME) {
  await ctx.addInitScript((t) => { try { localStorage.setItem('graphify-theme', t); } catch (e) {} }, THEME);
}
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
await page.goto('http://127.0.0.1:8275/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2000);

// pick a node with a decent neighbourhood and put it in the middle of the canvas
const target = await page.evaluate((scale) => {
  const ids = Object.keys(network.body.nodes);
  let best = null, bestN = -1;
  for (const id of ids) {
    const n = network.body.nodes[id];
    if (!n || n.x === undefined) continue;
    const deg = (network.getConnectedNodes(id) || []).length;
    if (deg > bestN && deg < 40) { bestN = deg; best = id; }
  }
  const p = network.getPositions()[best];
  network.moveTo({ position: { x: p.x, y: p.y }, scale: scale, animation: false });
  return { id: best, deg: bestN, scale };
}, SCALE);
await page.waitForTimeout(600);
// The scene needs a couple of redraws to settle: a fresh page paints the labels a
// frame late, and a base frame captured before that would never match again.
await page.evaluate(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 3; i++) { network.redraw(); await wait(250); }
});

await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  window.__base = ctx.getImageData(0, 0, cv.width, cv.height).data;
  window.__state = function () {
    const nodes = network.body.nodes;
    let dimmed = 0, bright = 0, total = 0;
    for (const id in nodes) {
      const n = nodes[id];
      const c = n && n.options && n.options.color;
      if (!c || typeof c !== 'object' || !c.background) continue;
      total++;
      if (String(c.background).indexOf('rgb(') === 0) dimmed++; else bright++;
    }
    const cur = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let diff = 0, white = 0;
    for (let i = 0; i < cur.length; i += 4) {
      if (Math.abs(cur[i] - window.__base[i]) > 8 ||
          Math.abs(cur[i + 1] - window.__base[i + 1]) > 8 ||
          Math.abs(cur[i + 2] - window.__base[i + 2]) > 8) diff++;
      if (cur[i] > 200 && cur[i + 1] > 200 && cur[i + 2] > 200) white++;
    }
    return {
      dimmed, bright, total, diffFromRest: diff, white,
      selected: network.getSelectedNodes ? network.getSelectedNodes() : [],
      scale: +network.getScale().toFixed(5),
      pos: network.getViewPosition(),
    };
  };
});

const state = () => page.evaluate(() => window.__state());
const box = await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const r = cv.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});

await page.mouse.move(box.x, box.y);
await page.waitForTimeout(250);
await page.mouse.click(box.x, box.y);
await page.waitForTimeout(600);
const focused = await state();
if (SHOT) await page.screenshot({ path: path.join(LAB, SHOT) });

// click empty space: the picture must come back exactly
await page.mouse.click(box.x + 240, box.y - 190);
await page.waitForTimeout(700);
const restored = await state();

// the reference frame is taken now, with nothing focused and the labels settled
await page.evaluate(() => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  window.__base = ctx.getImageData(0, 0, cv.width, cv.height).data;
});
const base = await state();

// click again, then click the same node once more (toggle off)
await page.mouse.click(box.x, box.y);
await page.waitForTimeout(500);
const focused2 = await state();
await page.mouse.click(box.x, box.y);
await page.waitForTimeout(500);
const toggledOff = await state();

// Escape clears it
await page.mouse.click(box.x, box.y);
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
const escaped = await state();

const show = (label, s) => console.log(
  `  ${label.padEnd(18)} ${String(s.bright).padStart(5)} bright / ${String(s.dimmed).padStart(5)} dimmed` +
  `   pixels differing from rest: ${s.diffFromRest}` +
  `   scale ${s.scale} pos ${s.pos ? s.pos.x.toFixed(1) + ',' + s.pos.y.toFixed(1) : '?'}` +
  (s.selected && s.selected.length ? `   selected ${JSON.stringify(s.selected)}` : '') +
  `   white px ${s.white}`);

console.log(`${path.basename(FILE)}  node ${target.id} (${target.deg} neighbours), zoom ${target.scale}`);
show('rest (reference)', base);
show('after click', focused);
show('click empty space', restored);
show('click again', focused2);
show('click same node', toggledOff);
show('escape', escaped);
if (errors.length) console.log('  errors: ' + errors.slice(0, 3).join(' | '));

await browser.close();
srv.close();
