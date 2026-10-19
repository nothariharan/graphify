// What GPU/renderer does headless Chrome actually use? (WebGL vs SwiftShader)
//   node harness/gl_probe.mjs [--swiftshader]
import { chromium } from 'playwright-core';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sw = process.argv.includes('--swiftshader');
const args = ['--no-first-run', '--no-default-browser-check', '--disable-features=CalculateNativeWinOcclusion'];
if (sw) args.push('--enable-unsafe-swiftshader', '--use-gl=swiftshader');
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args });
const page = await browser.newPage();
await page.goto('about:blank');
const info = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  if (!gl) return { webgl: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webgl: true,
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
});
await browser.close();
console.log(JSON.stringify({ swiftshaderForced: sw, info }, null, 1));
