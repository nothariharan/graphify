// Does the node keep its white hover / selection ring, and does the hover focus still
// dim the rest? (L21 removes the node border, which is the same colour as the fill, and
// puts a real border back only where the border is visible: hovered and selected nodes.)
//
//   node harness/probe_node_ring.mjs --file variants/L21-noborder.html
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
const SCALE = parseFloat(arg('scale', '2.0'));

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(8271, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)));
await page.goto('http://127.0.0.1:8271/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => {
  try { return network.physics.options.enabled === false; } catch (e) { return false; }
}, null, { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(2000);

const out = await page.evaluate(async (scale) => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const grab = () => Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data);
  const whites = (a) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] > 200 && a[i + 1] > 200 && a[i + 2] > 200) n++;
    return n;
  };
  const diff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > 16) n++;
    }
    return { n, whiteA: whites(a), whiteB: whites(b) };
  };
  const nodes = Object.keys(network.body.nodes);
  const id = nodes[Math.floor(nodes.length / 2)];
  const p = network.getPositions()[id];
  // zoom in on the node: at the fit scale a 1.5 unit border is 0.12 px and cannot be seen
  network.moveTo({ position: { x: p.x, y: p.y }, scale: scale, animation: false });
  await wait(400);
  const r = { node: id, scale };

  // rest
  network.redraw(); await wait(300);
  const base = grab();

  // The selection ring is drawn from the node's selected state, which vis flips in its
  // own click handler. network.setSelection() does not fire 'selectNode', so the click
  // goes through the real mouse.
  const box = await cv.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  r.clickAt = [Math.round(cx), Math.round(cy)];
  return r;
}, SCALE);

// real mouse: move onto the node and click it
await page.mouse.move(out.clickAt[0], out.clickAt[1]);
await page.waitForTimeout(300);
await page.mouse.click(out.clickAt[0], out.clickAt[1]);
await page.waitForTimeout(500);

const after = await page.evaluate(async () => {
  const cv = document.querySelector('#graph canvas');
  const ctx = cv.getContext('2d');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const grab = () => Array.from(ctx.getImageData(0, 0, cv.width, cv.height).data);
  const whites = (a) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] > 200 && a[i + 1] > 200 && a[i + 2] > 200) n++;
    return n;
  };
  const cur = grab();
  const ids = Object.keys(network.body.nodes);
  const sel = (network.getSelectedNodes ? network.getSelectedNodes() : []);
  const n = network.body.nodes[ids[Math.floor(ids.length / 2)]];
  return { white: whites(cur), selected: sel, borderWidth: n.options.borderWidth, size: n.options.size };
});
out.selected = after.selected;
out.borderWidth = after.borderWidth;
out.size = after.size;
out.whiteAfterClick = after.white;

if (SHOT) await page.screenshot({ path: path.join(LAB, SHOT) });
console.log(`${path.basename(FILE)}  node ${out.node}  zoom ${out.scale}`);
console.log(`  clicked at ${JSON.stringify(out.clickAt)} -> selected ${JSON.stringify(out.selected)}, borderWidth ${out.borderWidth}, size ${out.size}`);
console.log(`  white pixels after the click: ${out.whiteAfterClick}`);
if (errors.length) console.log('  errors: ' + errors.slice(0, 3).join(' | '));
await browser.close();
srv.close();
