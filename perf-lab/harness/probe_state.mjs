// Why does one variant's canvas draw cost 3x another's? Raster cost scales with
// how many nodes are on screen and how big they are, so measure exactly that.
//   node harness/probe_state.mjs --file variants/base-rsl.html
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
const LABEL = arg('label', 'probe');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b); });
});
await new Promise(r => srv.listen(8223, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });

// run twice: fresh (no localStorage) and cached, to expose cache-driven differences
const runs = [];
for (const clear of [true, false]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  if (clear) {
    await page.goto('http://127.0.0.1:8223/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await page.reload({ waitUntil: 'load', timeout: 120000 });
  } else {
    await page.goto('http://127.0.0.1:8223/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
  }
  await page.waitForTimeout(4000);
  const s = await page.evaluate(() => {
    try { network.fit({ animation: false }); } catch (e) {}
    const W = innerWidth, H = innerHeight;
    let vis = 0, minr = 1e9, maxr = 0, sumr = 0;
    let nodeOptionSize = 0, borderWidth = 0, hiddenEdgeOption = null, hideNodesOnDrag = null, physicsEnabled = null;
    try {
      const first = nodesDS.getIds()[0];
      nodeOptionSize = network.body.nodes[first].options.size;
      borderWidth = network.body.nodes[first].options.borderWidth;
    } catch (e) {}
    try {
      const io = network.body.interactionHandler && network.body.interactionHandler.options;
      if (io) { hiddenEdgeOption = io.hideEdgesOnDrag; hideNodesOnDrag = io.hideNodesOnDrag; }
    } catch (e) {}
    try { physicsEnabled = !!(network.physics && network.physics.options && network.physics.options.enabled); } catch (e) {}
    for (const id of nodesDS.getIds()) {
      const p = network.canvasToDOM(network.getPosition(id));
      if (p.x < -20 || p.y < -20 || p.x > W + 20 || p.y > H + 20) continue;
      vis++;
      const size = (function () { try { return network.body.nodes[id].options.size; } catch (e) { return 0; } })();
      const r = size * network.getScale();
      minr = Math.min(minr, r); maxr = Math.max(maxr, r); sumr += r;
    }
    const pos = network.getPositions();
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const k in pos) { x0 = Math.min(x0, pos[k].x); x1 = Math.max(x1, pos[k].x); y0 = Math.min(y0, pos[k].y); y1 = Math.max(y1, pos[k].y); }
    return {
      scale: +network.getScale().toFixed(4),
      nodes: nodesDS.length, edges: edgesDS.length,
      nodeOptionSize,
      borderWidth,
      physicsEnabled,
      hiddenEdgeOption,
      hideNodesOnDrag,
      visibleNodes: vis,
      avgScreenRadius: +(sumr / Math.max(1, vis)).toFixed(2),
      maxScreenRadius: +maxr.toFixed(2),
      bboxW: +(x1 - x0).toFixed(0), bboxH: +(y1 - y0).toFixed(0),
      labelsDrawn: nodesDS.get().filter(n => n.font && n.font.size > 0).length,
    };
  });
  runs.push({ clearedLocalStorage: clear, ...s });
  await ctx.close();
}
await browser.close();
srv.close();
console.log(JSON.stringify({ label: LABEL, file: FILE, runs }, null, 1));
