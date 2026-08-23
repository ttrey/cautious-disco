// Boots the game and captures a screenshot looking toward given yaw (radians).
// Usage: node .qa/look.mjs <outPrefix> <yawDeg> [moveSeconds]
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const [, , out = '.qa/shots/look', yawDeg = '180', moveSecs = '0'] = process.argv;

const exe = execSync(
  `ls -d "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" | tail -1`,
)
  .toString()
  .trim();

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).slice(0, 300)));

await page.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 45000 });
await page.waitForTimeout(2000);

const clickText = async (txt) =>
  page.evaluate((t) => {
    const els = Array.from(document.querySelectorAll('button'));
    const el = els.find((e) => e.textContent && e.textContent.toUpperCase().includes(t));
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, txt);

await clickText('SINGLE');
await page.waitForFunction(
  () => !Array.from(document.querySelectorAll('div')).some((d) => /PREPARING MATCH/i.test(d.textContent || '')) &&
    Array.from(document.querySelectorAll('button')).some((e) => /ENTER SECTOR|START/i.test(e.textContent || '')),
  { timeout: 90000 },
);
for (const t of ['ENTER SECTOR', 'START']) {
  if (await clickText(t)) break;
}
await page.waitForTimeout(2500);

// Drag-look: pointer-lock mouse movement to turn to the requested heading.
await page.mouse.move(800, 450);
await page.mouse.down();
// MovementX accumulates; ~0.15 deg per px typical sensitivity. Move in steps.
const totalPx = Math.round(Number(yawDeg) / 0.09);
for (let i = 0; i < 20; i++) {
  await page.mouse.move(800 + ((i % 2) * 2 - 1), 450, { steps: 1 });
  await page.mouse.move(800 + totalPx / 20, 450);
}
await page.mouse.up();

if (Number(moveSecs) > 0) {
  await page.keyboard.down('w');
  await page.waitForTimeout(Number(moveSecs) * 1000);
  await page.keyboard.up('w');
  await page.waitForTimeout(400);
}

await page.screenshot({ path: `${out}.png` });
console.log('saved', `${out}.png`);
await browser.close();
