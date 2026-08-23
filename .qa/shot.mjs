// Screenshot harness: loads a local page, waits for WebGL, captures PNG.
// Usage: node .qa/shot.mjs <url-path> <outfile.png> [waitMs] [evalJs]
//   evalJs runs after load (e.g. "__slab.view('faceQuarter')"), then waits 400ms.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const [, , urlPath, out, waitMs = '3500', evalJs = ''] = process.argv;
if (!urlPath || !out) {
  console.error('usage: node shot.mjs <url-path> <out.png> [waitMs] [evalJs]');
  process.exit(1);
}

const exe =
  execSync(
    `ls -d "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" | tail -1`,
  )
    .toString()
    .trim();

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--no-first-run'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).slice(0, 300)));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('CONSOLE:', m.text().slice(0, 200));
});

await page.goto(urlPath.startsWith('http') ? urlPath : `http://localhost:5173${urlPath}`, {
  waitUntil: 'load',
  timeout: 45000,
});
await page.waitForTimeout(Number(waitMs));
if (evalJs) {
  await page.evaluate(evalJs);
  await page.waitForTimeout(500);
}
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
