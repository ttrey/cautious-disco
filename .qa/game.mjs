// Boots the real game (menu -> match), captures gameplay screenshots.
// Usage: node .qa/game.mjs <outPrefix> [moveSeconds]
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const [, , out = '.qa/shots/game', moveSecs = '0'] = process.argv;

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
    const els = Array.from(document.querySelectorAll('button, .btn, [role=button], div[class*=button], a'));
    const el = els.find((e) => e.textContent && e.textContent.toUpperCase().includes(t));
    if (el) {
      el.click();
      return el.textContent.trim().slice(0, 40);
    }
    return null;
  }, txt);

// Force HIGH preset if the selector exists.
await page.evaluate(() => {
  const sel = document.querySelector('select');
  if (sel) {
    for (const o of Array.from(sel.options)) {
      if (o.text.toUpperCase().includes('HIGH')) {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }
  }
});

console.log('single player:', await clickText('SINGLE'));

// Wait until the loader disappears and an in-game start control appears (max 90s).
await page.waitForFunction(
  () => {
    const loader = Array.from(document.querySelectorAll('div')).find((d) =>
      /PREPARING MATCH/i.test(d.textContent || ''),
    );
    const ready =
      !loader &&
      Array.from(document.querySelectorAll('button, div[class*=button]')).some((e) =>
        /START|BEGIN|DEPLOY/i.test(e.textContent || ''),
      );
    return ready;
  },
  { timeout: 90000 },
);
await page.screenshot({ path: `${out}_briefing.png` });

for (const t of ['ENTER SECTOR', 'START', 'BEGIN', 'DEPLOY']) {
  if (await clickText(t)) break;
}
await page.waitForTimeout(4000); // banner + intermission settle

await page.screenshot({ path: `${out}_spawn.png` });

if (Number(moveSecs) > 0) {
  await page.keyboard.down('w');
  await page.waitForTimeout(Number(moveSecs) * 1000);
  await page.keyboard.up('w');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}_moved.png` });
}

await page.mouse.down({ button: 'right' });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}_ads.png` });
await page.mouse.up({ button: 'right' });

console.log('done');
await browser.close();
