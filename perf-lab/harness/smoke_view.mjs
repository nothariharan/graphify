// Smoke-test a rendered graph page: does it load, build the network, and stay free of
// JS errors? Prints the node/edge counts, the levers it finds, and any console/page errors.
//
//   node harness/smoke_view.mjs --file view/after.html
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const srv = http.createServer((req, res) => {
  const p = path.join(LAB, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { console.log('  [server] 404 ' + req.url); res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(b);
  });
});
await new Promise(r => srv.listen(8232, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(r.status() + ' ' + r.url()); });
await page.goto('http://127.0.0.1:8232/' + FILE.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });

let state = {};
try {
  state = await page.evaluate(() => ({
    visDefined: typeof vis !== 'undefined',
    networkDefined: typeof network !== 'undefined',
    nodes: typeof nodesDS !== 'undefined' ? nodesDS.length : null,
    edges: typeof edgesDS !== 'undefined' ? edgesDS.length : null,
    physicsOff: (() => { try { return network.physics.options.enabled === false; } catch (e) { return null; } })(),
    drawnNodes: (() => { try { return Object.keys(network.body.nodes).length; } catch (e) { return null; } })(),
    hasLean: typeof window !== 'undefined' && /function _setLean/.test(document.documentElement.innerHTML),
    sidebar: document.querySelectorAll('#sidebar *').length,
  }));
} catch (e) {
  errors.push('evaluate: ' + e.message);
}

// one interaction: hover a node, then drag the background briefly
let interaction = 'skipped';
try {
  const cv = await page.$('#graph canvas');
  const box = await cv.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  interaction = 'ok';
} catch (e) {
  interaction = 'failed: ' + e.message;
}

await browser.close();
srv.close();
console.log(`${path.basename(FILE)}: vis=${state.visDefined} network=${state.networkDefined} nodes=${state.nodes} edges=${state.edges} drawn=${state.drawnNodes} physicsOff=${state.physicsOff} lean=${state.hasLean}`);
console.log(`  sidebar nodes=${state.sidebar}  interaction=${interaction}`);
console.log(`  http>=400: ${badResponses.length ? badResponses.join(' | ') : 'none'}`);
console.log(`  errors: ${errors.length ? '\n    - ' + errors.join('\n    - ') : 'none'}`);
