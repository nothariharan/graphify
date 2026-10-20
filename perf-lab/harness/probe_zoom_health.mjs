// Zoom health probe: does a real in/out zoom freeze the page, leave the lean stuck,
// or wash the node colours out? Loads the page, optionally clicks a node (selection),
// then wheels in and out while sampling rAF frame times, and dumps the post-gesture
// canvas/node state.
//
//   node harness/probe_zoom_health.mjs --file view/after.html [--click 1] [--shot out.png]
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
const DO_CLICK = arg('click', '1') === '1';
const SHOT = arg('shot', '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise(r => srv.listen(8234, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:8234/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });

// Wait for the graph to exist, physics to be off, and the first frame to settle.
await page.waitForFunction(() => typeof network !== 'undefined' && network.body && network.body.nodes &&
  Object.keys(network.body.nodes).length > 0, null, { timeout: 180000 });
await page.waitForTimeout(1200);

const snap = () => page.evaluate(() => {
  const ids = Object.keys(network.body.nodes);
  const sample = ids.slice(0, 12).map((id) => {
    const n = network.body.nodes[id];
    let fv = null;
    try {
      const ctx = network.body.renderer.ctx;
      fv = n.getFormattingValues(ctx, false, false, false);
    } catch (e) {}
    const ds = nodesDS.get(id);
    return {
      id,
      colorBg: ds && ds.color && ds.color.background ? ds.color.background : null,
      colorBorder: ds && ds.color && ds.color.border ? ds.color.border : null,
      dsOpacity: ds ? (ds.opacity === undefined ? null : ds.opacity) : null,
      fvColor: fv ? (typeof fv.color === 'object' ? fv.color.background : fv.color) : null,
      fvAlpha: fv && fv.opacity !== undefined ? fv.opacity : null,
      fvBorder: fv ? fv.borderWidth : null,
    };
  });
  // Count the instance colour state (v8 mutates options.color, not the DataSet).
  let white = 0, dim = 0, noColor = 0, dimColor = 0;
  for (const id of ids) {
    const inst = network.body.nodes[id];
    const ic = inst && inst.options && inst.options.color;
    const bg = ic && ic.background;
    if (bg === '#ffffff' || bg === '#FFFFFF') white++;
    if (typeof bg === 'string' && bg.indexOf('rgb(') === 0) dimColor++;
    if (!nodesDS.get(id)) noColor++;
  }
  function ds0(id) { return nodesDS.get(id); }
  let overridden = 0;
  for (const eid in network.body.edges) {
    const et = network.body.edges[eid] && network.body.edges[eid].edgeType;
    if (et && Object.prototype.hasOwnProperty.call(et, 'drawLine')) overridden++;
  }
  return {
    nodes: ids.length,
    scale: (() => { try { return network.getScale(); } catch (e) { return null; } })(),
    lean: (() => { try { return _lean; } catch (e) { return 'n/a'; } })(),
    globalAlpha: (() => { try { return network.body.renderer.ctx.globalAlpha; } catch (e) { return null; } })(),
    overriddenEdges: overridden,
    whiteNodes: white,
    dimmedNodes: dim,
    dimColorNodes: dimColor,
    domNodes: document.getElementsByTagName('*').length,
    selected: (() => { try { return network.getSelectedNodes(); } catch (e) { return []; } })(),
    physics: (() => { try { return network.physics.options.enabled; } catch (e) { return null; } })(),
    sample,
  };
});

const before = await snap();

// Click a node near the middle of the viewport so selection/highlight paths fire.
let clicked = null;
if (DO_CLICK) {
  clicked = await page.evaluate(() => {
    const cv = document.querySelector('#graph canvas');
    const r = cv.getBoundingClientRect();
    const c = { x: r.width / 2, y: r.height / 2 };
    const dom = network.canvasToDOM(network.getViewPosition());
    let best = null, bd = Infinity;
    for (const id in network.body.nodes) {
      const p = network.getPositions([id])[id];
      const q = network.canvasToDOM(p);
      const d = (q.x - dom.x) ** 2 + (q.y - dom.y) ** 2;
      if (d < bd) { bd = d; best = { id, x: q.x, y: q.y }; }
    }
    return best;
  });
  if (clicked) {
    const box = await (await page.$('#graph canvas')).boundingBox();
    await page.mouse.move(box.x + clicked.x, box.y + clicked.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
}
const afterClick = await snap();

// Frame sampler.
await page.evaluate(() => {
  window.__zt = { frames: [], on: true, last: performance.now() };
  const tick = () => {
    const now = performance.now();
    window.__zt.frames.push(now - window.__zt.last);
    window.__zt.last = now;
    if (window.__zt.on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

async function wheelRun(dir, steps) {
  await page.evaluate(() => { window.__zt.frames = []; });
  const box = await (await page.$('#graph canvas')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let mid = null;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dir * 120);
    await page.waitForTimeout(16);
    if (i === Math.floor(steps / 2)) mid = await snap();
  }
  await page.waitForTimeout(500);
  const frames = await page.evaluate(() => window.__zt.frames.slice());
  return { frames, mid };
}

const inRun = await wheelRun(-1, 14);
const inFrames = inRun.frames;
const midIn = inRun.mid;
const afterIn = await snap();
const outRun = await wheelRun(1, 14);
const outFrames = outRun.frames;
const midOut = outRun.mid;
const afterOut = await snap();

await page.waitForTimeout(1200);
const settled = await snap();

// Move off the graph and let the hover blur restore run; a stuck dim shows up here.
const cbox = await (await page.$('#graph canvas')).boundingBox();
await page.mouse.move(cbox.x + 6, cbox.y + cbox.height - 6);
await page.waitForTimeout(500);
const afterAway = await snap();

// Hover focus: dim on hover, restored on blur (v8 behaviour; 0 on v7).
// Note: vis does not emit hoverNode from Playwright's synthetic mouse path in
// headless Chrome -- the HEAD baseline page behaves identically (its tooltip shows
// the node while hoverNode stays silent), so this is an instrument limit, not a
// page bug. Try the real pointer first, then drive the engine's own event.
let hoverVia = 'mouse';
const target = await page.evaluate(() => {
  const dom = network.canvasToDOM(network.getViewPosition());
  let best = null, bd = Infinity;
  for (const id in network.body.nodes) {
    const q = network.canvasToDOM(network.getPositions([id])[id]);
    const d = (q.x - dom.x) ** 2 + (q.y - dom.y) ** 2;
    if (d < bd) { bd = d; best = { id, x: q.x, y: q.y }; }
  }
  return best;
});
await page.mouse.move(cbox.x + target.x, cbox.y + target.y);
await page.waitForTimeout(450);
let hovered = await snap();
if (hovered.dimColorNodes === 0) {
  hoverVia = 'network.emit(hoverNode)';
  await page.evaluate((nid) => { network.emit('hoverNode', { node: nid }); return null; }, target.id);
  await page.waitForTimeout(450);
  hovered = await snap();
}
await page.mouse.move(cbox.x + 6, cbox.y + cbox.height - 6);
await page.waitForTimeout(500);
let unhovered = await snap();
if (hoverVia !== 'mouse' && unhovered.dimColorNodes > 0) {
  await page.evaluate(() => { network.emit('blurNode', {}); return null; });
  await page.waitForTimeout(500);
  unhovered = await snap();
}

function stats(frames) {
  const f = frames.filter((x) => x > 0).sort((a, b) => a - b);
  if (!f.length) return { n: 0 };
  const q = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
  return {
    n: f.length,
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +f[f.length - 1].toFixed(1),
    over33: f.filter((x) => x > 33).length,
    over250: f.filter((x) => x > 250).length,
  };
}

if (SHOT) {
  await page.screenshot({ path: SHOT });
}

await browser.close();
srv.close();

const dump = { file: FILE, clicked, before, afterClick, afterIn, afterOut, settled };
delete dump.before.sample;
const pick = (s) => ({
  scale: s.scale, lean: s.lean, alpha: s.globalAlpha, overriddenEdges: s.overriddenEdges,
  white: s.whiteNodes, dimmed: s.dimmedNodes, dimColor: s.dimColorNodes,
  dom: s.domNodes, selected: s.selected, physics: s.physics,
});
console.log(JSON.stringify({
  file: FILE,
  clicked: clicked && clicked.id,
  frames_in: stats(inFrames),
  frames_out: stats(outFrames),
  midIn: midIn && pick(midIn),
  midOut: midOut && pick(midOut),
  before: pick(before),
  afterClick: pick(afterClick),
  afterIn: pick(afterIn),
  afterOut: pick(afterOut),
  settled: pick(settled),
  afterAway: pick(afterAway),
  hoverVia,
  hovered: pick(hovered),
  unhovered: pick(unhovered),
  errors,
}, null, 2));
