// Interleaved rest-frame A/B. The gesture harness cannot see this lever: it only bites
// when nothing is being dragged, which is the frame every hover, selection, legend toggle
// and the next gesture starts from.
//
// For each variant the page is loaded fresh (cold layout cache), left to settle, then:
//   rest  - one forced redraw per rAF for N frames; the frame interval IS the draw cost
//   hover - hover focus painted on a central node, same forced-redraw sampling
// Variants are interleaved inside every round and the order rotates, because this host
// drifts ~3x between batches.
//
//   node harness/ab_rest.mjs --variants "v8=variants/base-ours-v8.html,rest=variants/L12-rest-batch.html" \
//        --rounds 3 --frames 60 --out results/ab-rest-L12.csv
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
const ROUNDS = parseInt(arg('rounds', '3'), 10);
const FRAMES = parseInt(arg('frames', '60'), 10);
const OUT = arg('out', 'results/ab-rest.csv');
const PORT = parseInt(arg('port', '8241'), 10);

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run', '--no-default-browser-check'],
});

async function sample(file, phase) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/` + file.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => {
    try { return typeof network !== 'undefined' && network.physics && network.physics.options.enabled === false; }
    catch (e) { return false; }
  }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(900);

  const res = await page.evaluate(async ({ frames, phase }) => {
    // a node near the view centre, for the hover phase
    const target = (() => {
      const dom = network.canvasToDOM(network.getViewPosition());
      let best = null, bd = Infinity;
      for (const id in network.body.nodes) {
        const p = network.getPositions([id])[id];
        const q = network.canvasToDOM(p);
        const d = (q.x - dom.x) ** 2 + (q.y - dom.y) ** 2;
        if (d < bd) { bd = d; best = id; }
      }
      return best;
    })();

    const one = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
    const out = [];
    // warm-up frames, discarded
    for (let i = 0; i < 8; i++) { network.redraw(); await one(); }
    if (phase === 'hover') {
      network.emit('hoverNode', { node: target });
      await new Promise((r) => setTimeout(r, 250));
    }
    let last = await one();
    for (let i = 0; i < frames; i++) {
      network.redraw();
      const t = await one();
      out.push(t - last);
      last = t;
    }
    // Synchronous draw cost: Canvas.redraw() draws immediately, so this is the number
    // a hover/selection actually pays (one full frame of pixels, no rAF scheduling).
    const draw = [];
    try {
      const r = network.body.renderer;
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        r.redraw();
        draw.push(performance.now() - t0);
      }
    } catch (e) { draw.push(-1); }
    const batches = (() => {
      try { return Object.keys(network.body.edges).filter((k) => {
        const et = network.body.edges[k].edgeType;
        return et && Object.prototype.hasOwnProperty.call(et, 'drawLine');
      }).length; } catch (e) { return -1; }
    })();
    return { frames: out, draw, batchedEdges: batches, target };
  }, { frames: FRAMES, phase });

  await ctx.close();
  return { ...res, errors: errs };
}

function stats(f) {
  const a = f.filter((x) => x > 0).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    n: a.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +a[a.length - 1].toFixed(1),
    over33: a.filter((x) => x > 33).length,
  };
}

const rows = [];
for (let round = 1; round <= ROUNDS; round++) {
  const order = round % 2 === 1 ? VARIANTS : [...VARIANTS].reverse();
  for (const v of order) {
    for (const phase of ['rest', 'hover']) {
      const r = await sample(v.file, phase);
      const st = stats(r.frames);
      const sd = stats(r.draw);
      rows.push({ round, variant: v.name, phase, ...st, drawP50: sd.p50, drawP95: sd.p95, batchedEdges: r.batchedEdges, error: r.errors.join('; ') });
      console.log(`round ${round}  ${v.name.padEnd(10)} ${phase.padEnd(5)}  frame p50 ${String(st.p50).padStart(6)}  draw p50 ${String(sd.p50).padStart(6)} p95 ${String(sd.p95).padStart(6)}  batched ${r.batchedEdges}`);
    }
  }
}

await browser.close();
srv.close();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const head = 'round,variant,phase,frames,p50,p95,max,over33,drawP50,drawP95,batchedEdges,error';
fs.writeFileSync(OUT, [head, ...rows.map((r) => [r.round, r.variant, r.phase, r.n, r.p50, r.p95, r.max, r.over33, r.drawP50, r.drawP95, r.batchedEdges, JSON.stringify(r.error || '')].join(','))].join('\n') + '\n');
console.log('wrote', OUT);
