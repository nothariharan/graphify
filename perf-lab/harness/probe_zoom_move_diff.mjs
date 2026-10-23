// Why zoom and mouse-move lag once you are already inside a dense cluster.
// hideEdgesOnDrag is forced off on both pages, so a drag is not the official
// "edges vanish" path. Wheel and a button-up mouse move never used that path.
//
//   node harness/probe_zoom_move_diff.mjs
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAB = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8337;
const FILES = (process.argv.includes('--files')
  ? process.argv[process.argv.indexOf('--files') + 1].split(',')
  : ['view/before.html', 'view/after.html', 'view/after-traced.html']);
const DPR = Number(process.argv.includes('--dpr') ? process.argv[process.argv.indexOf('--dpr') + 1] : '1');

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const pageOpts = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR };

function q(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function cpuTop(profile, n = 8) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const id = profile.samples[i];
    self.set(id, (self.get(id) || 0) + (deltas[i] || 0));
  }
  const merged = new Map();
  for (const [id, us] of self) {
    const node = byId.get(id);
    if (!node) continue;
    const f = node.callFrame;
    const where = (f.url || '').split('/').pop().split('?')[0];
    const label = (f.functionName || '(anon)') + (where ? ' @ ' + where : '');
    merged.set(label, (merged.get(label) || 0) + us / 1000);
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([label, ms]) => ({ label, ms: Math.round(ms * 10) / 10 }));
}

async function measure(file) {
  const page = await browser.newPage(pageOpts);
  await page.goto(`http://127.0.0.1:${PORT}/${file}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => {
    try { return network.physics.options.enabled === false; } catch (e) { return false; }
  }, null, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(800);

  const ready = await page.evaluate(() => {
    try {
      network.setOptions({ interaction: { hideEdgesOnDrag: false, hideEdgesOnZoom: false } });
    } catch (e) {}
    const opt = (network.interactionHandler && network.interactionHandler.options) || {};
    return {
      hover: opt.hover,
      hideDrag: opt.hideEdgesOnDrag,
      hideZoom: opt.hideEdgesOnZoom,
      fit: network.getScale(),
      nodes: Object.keys(network.body.nodes).length,
      edges: Object.keys(network.body.edges).length,
    };
  });

  async function geometry(tag) {
    return page.evaluate((tagName) => {
      const proto = CanvasRenderingContext2D.prototype;
      const orig = {
        beginPath: proto.beginPath,
        moveTo: proto.moveTo,
        lineTo: proto.lineTo,
        quadraticCurveTo: proto.quadraticCurveTo,
        bezierCurveTo: proto.bezierCurveTo,
        stroke: proto.stroke,
        fill: proto.fill,
        setTransform: proto.setTransform,
      };
      const frame = {
        on: false,
        strokes: [],
        fills: 0,
        curves: 0,
        moves: 0,
        minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
        inside: 0, outside: 0,
        pathMinX: Infinity, pathMinY: Infinity, pathMaxX: -Infinity, pathMaxY: -Infinity,
        pathCurves: 0, pathMoves: 0,
        maxLineWidth: 0,
      };
      let m = null;
      function xform(ctx) {
        if (!m) m = ctx.getTransform();
        return m;
      }
      function touch(ctx, x, y) {
        if (!frame.on) return;
        const t = xform(ctx);
        const dx = t.a * x + t.c * y + t.e;
        const dy = t.b * x + t.d * y + t.f;
        if (dx < frame.minX) frame.minX = dx;
        if (dy < frame.minY) frame.minY = dy;
        if (dx > frame.maxX) frame.maxX = dx;
        if (dy > frame.maxY) frame.maxY = dy;
        if (dx < frame.pathMinX) frame.pathMinX = dx;
        if (dy < frame.pathMinY) frame.pathMinY = dy;
        if (dx > frame.pathMaxX) frame.pathMaxX = dx;
        if (dy > frame.pathMaxY) frame.pathMaxY = dy;
        const w = ctx.canvas.width, h = ctx.canvas.height;
        if (dx >= -1 && dx <= w + 1 && dy >= -1 && dy <= h + 1) frame.inside++;
        else frame.outside++;
      }
      function resetPath() {
        frame.pathMinX = Infinity; frame.pathMinY = Infinity;
        frame.pathMaxX = -Infinity; frame.pathMaxY = -Infinity;
        frame.pathCurves = 0; frame.pathMoves = 0;
      }
      proto.setTransform = function () { m = null; return orig.setTransform.apply(this, arguments); };
      proto.beginPath = function () { resetPath(); return orig.beginPath.call(this); };
      proto.moveTo = function (x, y) { frame.moves++; frame.pathMoves++; touch(this, x, y); return orig.moveTo.call(this, x, y); };
      proto.lineTo = function (x, y) { touch(this, x, y); return orig.lineTo.call(this, x, y); };
      proto.quadraticCurveTo = function (cpx, cpy, x, y) {
        frame.curves++; frame.pathCurves++;
        touch(this, cpx, cpy); touch(this, x, y);
        return orig.quadraticCurveTo.call(this, cpx, cpy, x, y);
      };
      proto.bezierCurveTo = function (a, b, c, d, x, y) {
        frame.curves++; frame.pathCurves++;
        touch(this, a, b); touch(this, c, d); touch(this, x, y);
        return orig.bezierCurveTo.call(this, a, b, c, d, x, y);
      };
      proto.stroke = function () {
        if (frame.on) {
          frame.maxLineWidth = Math.max(frame.maxLineWidth, this.lineWidth || 0);
          const w = this.canvas.width, h = this.canvas.height;
          const bw = frame.pathMaxX - frame.pathMinX;
          const bh = frame.pathMaxY - frame.pathMinY;
          const finite = Number.isFinite(bw) && Number.isFinite(bh);
          const t = this.getTransform();
          const screenW = (this.lineWidth || 0) * Math.hypot(t.a, t.b);
          frame.strokes.push({
            curves: frame.pathCurves,
            moves: frame.pathMoves,
            bw: finite ? bw : 0,
            bh: finite ? bh : 0,
            over: finite && (bw > w * 1.5 || bh > h * 1.5),
            hit: finite && frame.pathMaxX >= 0 && frame.pathMinX <= w && frame.pathMaxY >= 0 && frame.pathMinY <= h,
            screenW,
          });
        }
        resetPath();
        return orig.stroke.call(this);
      };
      proto.fill = function () { if (frame.on) frame.fills++; return orig.fill.apply(this, arguments); };

      frame.on = true;
      const t0 = performance.now();
      network.redraw();
      const js = performance.now() - t0;
      frame.on = false;
      for (const k of Object.keys(orig)) proto[k] = orig[k];

      const cv = document.querySelector('#graph canvas');
      const strokes = frame.strokes;
      const giant = strokes.filter((s) => s.over);
      const withCurves = strokes.filter((s) => s.curves > 0);
      const biggest = withCurves.slice().sort((a, b) => b.curves - a.curves)[0] || null;
      const bucket = (pred) => {
        const rows = strokes.filter(pred);
        return {
          n: rows.length,
          hit: rows.filter((s) => s.hit).length,
          miss: rows.filter((s) => s.over && !s.hit).length,
          maxCurves: rows.reduce((m, s) => Math.max(m, s.curves), 0),
        };
      };
      const times = [];
      for (let i = 0; i < 3; i++) {
        const a = performance.now();
        network.redraw();
        times.push(performance.now() - a);
      }
      const f0 = performance.now();
      let flush = null, flushErr = null;
      try { cv.getContext('2d').getImageData(0, 0, 1, 1); flush = performance.now() - f0; }
      catch (e) { flushErr = String(e).slice(0, 120); }
      return {
        tag: tagName,
        scale: network.getScale(),
        canvas: { w: cv.width, h: cv.height },
        instrumentedJs: Math.round(js * 10) / 10,
        cleanJs: times.map((n) => Math.round(n * 10) / 10),
        flushMs: flush === null ? null : Math.round(flush * 10) / 10,
        flushErr,
        strokes: strokes.length,
        giantStrokes: giant.length,
        buckets: {
          empty: bucket((s) => s.curves === 0),
          one: bucket((s) => s.curves === 1),
          few: bucket((s) => s.curves >= 2 && s.curves < 10),
          many: bucket((s) => s.curves >= 10),
        },
        maxScreenW: Math.round(strokes.reduce((m, s) => Math.max(m, s.screenW || 0), 0) * 100) / 100,
        biggest: biggest && {
          curves: biggest.curves,
          moves: biggest.moves,
          bw: Math.round(biggest.bw),
          bh: Math.round(biggest.bh),
          hit: biggest.hit,
          screenW: Math.round(biggest.screenW * 100) / 100,
        },
        curves: frame.curves,
        moves: frame.moves,
        fills: frame.fills,
        inside: frame.inside,
        outside: frame.outside,
        extent: {
          w: Math.round(frame.maxX - frame.minX),
          h: Math.round(frame.maxY - frame.minY),
        },
        maxLineWidth: Math.round(frame.maxLineWidth * 100) / 100,
      };
    }, tag);
  }

  const fitGeo = await geometry('fit');

  const cam = await page.evaluate(() => {
    const pos = network.getPositions();
    const ids = Object.keys(network.body.nodes);
    let best = ids[0], bestN = -1;
    for (const id of ids) {
      const p = pos[id];
      if (!p) continue;
      let n = 0;
      for (const o of ids) {
        const q = pos[o];
        if (q && Math.hypot(q.x - p.x, q.y - p.y) < 260) n++;
      }
      if (n > bestN) { bestN = n; best = id; }
    }
    const c = pos[best];
    network.moveTo({ position: { x: c.x, y: c.y }, scale: 5, animation: false });
    window.__draws = [];
    window.__hovers = { node: 0, edge: 0 };
    window.__events = [];
    let t0 = 0;
    network.on('beforeDrawing', () => { t0 = performance.now(); });
    network.on('afterDrawing', () => { window.__draws.push(performance.now() - t0); });
    network.on('hoverNode', () => { window.__hovers.node++; });
    network.on('hoverEdge', () => { window.__hovers.edge++; });
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.entryType !== 'event') continue;
          window.__events.push({
            name: e.name,
            dur: e.duration,
            proc: e.processingEnd - e.processingStart,
          });
        }
      }).observe({ type: 'event', durationThreshold: 16 });
    } catch (err) {
      window.__eventsErr = String(err).slice(0, 160);
    }
    return { neighbours: bestN, id: best, scale: network.getScale() };
  });
  await page.waitForTimeout(400);
  const deepGeo = await geometry('scale5');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

  const box = await page.evaluate(() => {
    window.__draws = [];
    window.__hovers = { node: 0, edge: 0 };
    window.__events = [];
    const r = document.querySelector('#graph canvas').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
  });

  const traceEvents = [];
  cdp.on('Tracing.dataCollected', (p) => { for (const e of p.value) traceEvents.push(e); });
  await cdp.send('Tracing.start', {
    traceConfig: {
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame'],
      recordMode: 'recordAsMuchAsPossible',
    },
    transferMode: 'ReportEvents',
  });
  await cdp.send('Profiler.start');
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(250);
  const zoomProf = cpuTop((await cdp.send('Profiler.stop')).profile);
  await cdp.send('Tracing.end');
  await page.waitForTimeout(500);
  const zoomTrace = timeline(traceEvents);
  const zoom = await page.evaluate(() => ({
    draws: window.__draws.length,
    drawMs: window.__draws.map((n) => Math.round(n * 10) / 10),
    hovers: window.__hovers,
    events: window.__events,
    scale: network.getScale(),
    eventsErr: window.__eventsErr || null,
  }));

  await page.evaluate(() => {
    window.__draws = [];
    window.__hovers = { node: 0, edge: 0 };
    window.__events = [];
  });
  await cdp.send('Profiler.start');
  for (let i = 0; i < 24; i++) {
    const x = box.x - box.w / 4 + (i % 8) * (box.w / 16);
    const y = box.y - box.h / 4 + Math.floor(i / 8) * (box.h / 10);
    await page.mouse.move(x, y);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(200);
  const moveProf = cpuTop((await cdp.send('Profiler.stop')).profile);
  const move = await page.evaluate(() => ({
    draws: window.__draws.length,
    drawMs: window.__draws.map((n) => Math.round(n * 10) / 10),
    hovers: window.__hovers,
    events: window.__events,
  }));

  await page.evaluate(() => {
    window.__draws = [];
    window.__events = [];
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let s = 1; s <= 8; s++) {
    await page.mouse.move(box.x + s * 18, box.y + (s % 2 ? 8 : -8));
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
  const pan = await page.evaluate(() => ({
    draws: window.__draws.length,
    drawMs: window.__draws.map((n) => Math.round(n * 10) / 10),
    events: window.__events,
  }));

  await cdp.detach();
  await page.close();
  return { file, ready, cam, fitGeo, deepGeo, zoom, zoomProf, zoomTrace, move, moveProf, pan };
}

function timeline(events) {
  const sum = {};
  const frames = [];
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    sum[e.name] = (sum[e.name] || 0) + e.dur;
    if (e.name === 'DrawFrame') frames.push(e.dur / 1000);
  }
  const pick = (names) => Math.round(names.reduce((a, n) => a + (sum[n] || 0), 0) / 100) / 10;
  frames.sort((a, b) => a - b);
  return {
    frames: frames.length,
    frameP95: frames.length ? Math.round(frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))] * 10) / 10 : null,
    scriptMs: pick(['FunctionCall', 'EventDispatch', 'v8.run', 'RunTask']),
    paintMs: pick(['Paint', 'PaintImage', 'CompositeLayers']),
    rasterMs: pick(['RasterTask', 'Rasterize']),
  };
}

function briefEvents(events) {
  const by = {};
  for (const e of events || []) {
    const b = by[e.name] || (by[e.name] = []);
    b.push(e);
  }
  const out = {};
  for (const [name, rows] of Object.entries(by)) {
    out[name] = {
      n: rows.length,
      durP95: Math.round(q(rows.map((r) => r.dur), 0.95) * 10) / 10,
      procP95: Math.round(q(rows.map((r) => r.proc), 0.95) * 10) / 10,
      durMax: Math.round(Math.max(...rows.map((r) => r.dur)) * 10) / 10,
    };
  }
  return out;
}

const all = [];
for (const file of FILES) {
  console.log('measuring ' + file);
  const row = await measure(file);
  all.push(row);
  const d = row.deepGeo;
  console.log(JSON.stringify({
    file,
    hover: row.ready.hover,
    hideDrag: row.ready.hideDrag,
    hideZoom: row.ready.hideZoom,
    fitScale: row.ready.fit,
    neighbours: row.cam.neighbours,
    fit: {
      strokes: row.fitGeo.strokes,
      giant: row.fitGeo.giantStrokes,
      curves: row.fitGeo.curves,
      inside: row.fitGeo.inside,
      outside: row.fitGeo.outside,
      extent: row.fitGeo.extent,
      canvas: row.fitGeo.canvas,
      cleanJs: row.fitGeo.cleanJs,
      flushMs: row.fitGeo.flushMs,
      lineWidth: row.fitGeo.maxLineWidth,
      buckets: row.fitGeo.buckets,
      maxScreenW: row.fitGeo.maxScreenW,
    },
    deep: {
      strokes: d.strokes,
      giant: d.giantStrokes,
      buckets: d.buckets,
      maxScreenW: d.maxScreenW,
      biggest: d.biggest,
      curves: d.curves,
      inside: d.inside,
      outside: d.outside,
      extent: d.extent,
      canvas: d.canvas,
      cleanJs: d.cleanJs,
      flushMs: d.flushMs,
      flushErr: d.flushErr,
      lineWidth: d.maxLineWidth,
      fills: d.fills,
    },
    zoom: {
      draws: row.zoom.draws,
      drawP95: q(row.zoom.drawMs, 0.95),
      drawMax: row.zoom.drawMs.length ? Math.max(...row.zoom.drawMs) : null,
      endScale: row.zoom.scale,
      hovers: row.zoom.hovers,
      events: briefEvents(row.zoom.events),
      cpu: row.zoomProf,
      trace: row.zoomTrace,
    },
    move: {
      draws: row.move.draws,
      drawP95: q(row.move.drawMs, 0.95),
      drawMax: row.move.drawMs.length ? Math.max(...row.move.drawMs) : null,
      hovers: row.move.hovers,
      events: briefEvents(row.move.events),
      cpu: row.moveProf,
    },
    panEdgesForcedOn: {
      draws: row.pan.draws,
      drawP95: q(row.pan.drawMs, 0.95),
      drawMax: row.pan.drawMs.length ? Math.max(...row.pan.drawMs) : null,
      events: briefEvents(row.pan.events),
    },
  }, null, 2));
}

fs.writeFileSync(path.join(LAB, 'results', 'zoom-move-diff.json'), JSON.stringify(all, null, 2));
await browser.close();
srv.close();
