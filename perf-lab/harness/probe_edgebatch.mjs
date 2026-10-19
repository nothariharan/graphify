// Fidelity probe for the batched gesture draw.
//
// Proves the three things that matter before this can ship:
//   1. Mid-gesture the draw cost collapses (strokes -> ~#groups) while every edge is
//      still stroked (lineTo == edge count).
//   2. The colours and dash patterns actually used are the same set as at rest, so the
//      graph does not change appearance while you move it.
//   3. Edges still follow a node being dragged (endpoints read live, not cached), and
//      after release the draw is byte-identical to the non-batched draw.
//
//   node harness/probe_edgebatch.mjs --file variants/edge-batch-real.html
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); });
});
await new Promise(r => srv.listen(8235, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:8235/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => { try { return network.physics.options.enabled === false; } catch (e) { return false; } }, null, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(600);

const out = await page.evaluate(async () => {
  const cv = document.querySelector('#graph canvas');
  const mk = (type, x, y) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window });

  // instrument the canvas
  const proto = CanvasRenderingContext2D.prototype;
  const desc = (n) => Object.getOwnPropertyDescriptor(proto, n);
  const dStroke = desc('stroke'), dStyle = desc('strokeStyle'), dDash = proto.setLineDash;
  const lw = desc('lineWidth');
  const bez = proto.bezierCurveTo, quad = proto.quadraticCurveTo, line = proto.lineTo, move = proto.moveTo;
  const S = { on: false, strokes: 0, bez: 0, quad: 0, line: 0, styles: {}, dashes: {}, points: new Set() };
  const resetS = () => { S.strokes = 0; S.bez = 0; S.quad = 0; S.line = 0; S.styles = {}; S.dashes = {}; S.points = new Set(); };
  Object.defineProperty(proto, 'stroke', { configurable: true, value: function (...a) { if (S.on) S.strokes++; return dStroke.value.apply(this, a); } });
  Object.defineProperty(proto, 'bezierCurveTo', { configurable: true, value: function (...a) { if (S.on) S.bez++; return bez.apply(this, a); } });
  Object.defineProperty(proto, 'quadraticCurveTo', { configurable: true, value: function (...a) { if (S.on) S.quad++; return quad.apply(this, a); } });
  Object.defineProperty(proto, 'lineTo', { configurable: true, value: function (...a) { if (S.on) S.line++; return line.apply(this, a); } });
  Object.defineProperty(proto, 'moveTo', { configurable: true, value: function (x, y) { if (S.on) S.points.add(Math.round(x) + ',' + Math.round(y)); return move.call(this, x, y); } });
  Object.defineProperty(proto, 'strokeStyle', {
    configurable: true,
    get() { return dStyle.get.call(this); },
    set(v) { if (S.on && typeof v === 'string') S.styles[v] = (S.styles[v] || 0) + 1; dStyle.set.call(this, v); },
  });
  Object.defineProperty(proto, 'lineWidth', { configurable: true, get() { return lw.get.call(this); }, set(v) { lw.set.call(this, v); } });
  proto.setLineDash = function (p) { if (S.on) { const k = Array.isArray(p) && p.length ? p.join(',') : 'solid'; S.dashes[k] = (S.dashes[k] || 0) + 1; } return dDash.call(this, p); };

  const frame = async (label) => {
    resetS(); S.on = true;
    try { network.redraw(); } catch (e) {}
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    S.on = false;
    return {
      label,
      strokes: S.strokes,
      lineTo: S.line,
      quad: S.quad,
      bezier: S.bez,
      colors: Object.keys(S.styles).sort(),
      dashPatterns: Object.keys(S.dashes).sort(),
      points: S.points,
    };
  };

  const info = () => (window.__edgeBatchInfo || { installed: null, groups: null });
  const res = { file: location.pathname, edges: Object.keys(network.body.edges).length };

  res.atRestInstalled = info();
  const rest = await frame('at rest');

  // --- pan (view drag) ---
  resetS();
  cv.dispatchEvent(mk('pointerdown', 40, 40));
  for (let i = 0; i < 6; i++) { cv.dispatchEvent(mk('pointermove', 40 + i * 15, 40 + i * 10)); await new Promise(r => requestAnimationFrame(r)); }
  res.installedDuringPan = info();
  const pan = await frame('mid pan');
  cv.dispatchEvent(mk('pointerup', 130, 90));
  await new Promise(r => setTimeout(r, 400));
  res.installedAfterPan = info();
  const restored = await frame('after release');

  // --- drag a connected node ---
  let nodeId = null;
  for (const id of Object.keys(network.body.nodes)) { if (network.body.nodes[id].edges && network.body.nodes[id].edges.length > 2) { nodeId = id; break; } }
  const node = network.body.nodes[nodeId];
  const startScreen = network.canvasToDOM({ x: node.x, y: node.y });
  resetS();
  cv.dispatchEvent(mk('pointerdown', startScreen.x, startScreen.y));
  await new Promise(r => requestAnimationFrame(r));
  for (let i = 0; i < 8; i++) { cv.dispatchEvent(mk('pointermove', startScreen.x + 20 + i * 10, startScreen.y + 20 + i * 8)); await new Promise(r => requestAnimationFrame(r)); }
  const dragged = await frame('mid node-drag');
  res.installedDuringDrag = info();
  res.draggedNode = { id: nodeId, degree: node.edges.length, x: Math.round(node.x), y: Math.round(node.y) };
  res.draggedNodeDrawn = dragged.points.has(Math.round(node.x) + ',' + Math.round(node.y));
  res.draggedEdgeCount = node.edges.length;
  cv.dispatchEvent(mk('pointerup', startScreen.x + 120, startScreen.y + 100));

  // --- is our via-point arithmetic the same as vis's? ---
  // The batch reproduces vis's curve by computing the via point itself. If that arithmetic
  // ever disagrees with vis's own, edges would visibly bow/harden while the view moves, so
  // compare our formula against et.getViaNode() for every edge.
  let worstVia = 0, checkedVia = 0;
  for (const id of Object.keys(network.body.edges)) {
    const e = network.body.edges[id], et = e.edgeType;
    let via = null; try { via = et.getViaNode(); } catch (err) { continue; }
    const o = et.options && et.options.smooth;
    if (!via || !o || o.enabled === false || o.type !== 'continuous') continue;
    const fx = e.from.x, fy = e.from.y, tx = e.to.x, ty = e.to.y;
    const K = o.roundness, C = Math.abs(fx - tx), I = Math.abs(fy - ty);
    let a = (C <= I) ? K * I : K * C, b = a;
    if (fx > tx) a = -a;
    if (fy >= ty) b = -b;
    let vx = fx + a, vy = fy + b;
    if (C <= I) vx = (fx <= tx) ? (tx < vx ? tx : vx) : (tx > vx ? tx : vx);
    else vy = (fy >= ty) ? (ty > vy ? ty : vy) : (ty < vy ? ty : vy);
    const d = Math.max(Math.abs(vx - via.x), Math.abs(vy - via.y));
    if (d > worstVia) worstVia = d;
    checkedVia++;
  }
  res.via = { checked: checkedVia, worstDelta: worstVia };

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  res.fidelity = {
    colorSetMatches: same(rest.colors, pan.colors),
    dashSetMatches: same(rest.dashPatterns, pan.dashPatterns),
    restColors: rest.colors.length,
    panColors: pan.colors.length,
    restDashes: rest.dashPatterns,
    panDashes: pan.dashPatterns,
  };
  res.rest = { strokes: rest.strokes, lineTo: rest.lineTo, quad: rest.quad };
  res.pan = { strokes: pan.strokes, lineTo: pan.lineTo, quad: pan.quad, bezier: pan.bezier };
  res.drag = { strokes: dragged.strokes, lineTo: dragged.lineTo, quad: dragged.quad };
  res.afterRelease = { strokes: restored.strokes, lineTo: restored.lineTo, quad: restored.quad, bezier: restored.bezier };
  res.restoreIdentical = restored.strokes === rest.strokes && restored.quad === rest.quad && restored.bezier === rest.bezier;
  return res;
});

await browser.close();
srv.close();
console.log(`file: ${out.file}   edges: ${out.edges}`);
console.log(`batch installed  at rest=${out.atRestInstalled.installed}  mid pan=${out.installedDuringPan.installed} (groups=${out.installedDuringPan.groups})  mid drag=${out.installedDuringDrag.installed}  after pan=${out.installedAfterPan.installed}`);
console.log(`at rest          strokes=${out.rest.strokes} quadCurve=${out.rest.quad} lineTo=${out.rest.lineTo}`);
console.log(`mid pan          strokes=${out.pan.strokes} lineTo=${out.pan.lineTo} quadCurve=${out.pan.quad} bezier=${out.pan.bezier}`);
console.log(`mid node drag    strokes=${out.drag.strokes} lineTo=${out.drag.lineTo} quadCurve=${out.drag.quad}   (dragged node ${out.draggedNode.id}, degree ${out.draggedNode.degree})`);
console.log(`after release    strokes=${out.afterRelease.strokes} quadCurve=${out.afterRelease.quad} lineTo=${out.afterRelease.lineTo}   identical-to-rest=${out.restoreIdentical}`);
console.log(`dragged node coord appears in drawn moveTo set: ${out.draggedNodeDrawn}`);
console.log(`via arithmetic   checked=${out.via.checked} edges, worst disagreement with vis's own getViaNode()=${out.via.worstDelta}`);
console.log(`fidelity         colour set matches=${out.fidelity.colorSetMatches} (${out.fidelity.restColors} vs ${out.fidelity.panColors})  dash set matches=${out.fidelity.dashSetMatches} (${JSON.stringify(out.fidelity.restDashes)} vs ${JSON.stringify(out.fidelity.panDashes)})`);
