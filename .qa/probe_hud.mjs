// One-off probe: boots the game, catches the ROUND banner mid-display,
// screenshots it, then verifies #round recovers after the banner clears.
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';

const exe = execSync(
  `ls -d "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" | tail -1`,
).toString().trim();

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist', '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).slice(0, 300)));

await page.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 45000 });
await page.waitForTimeout(2000);

await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('button, .btn, [role=button], div[class*=button], a'));
  els.find((e) => e.textContent && e.textContent.toUpperCase().includes('SINGLE'))?.click();
});
await page.waitForFunction(() => {
  const loader = Array.from(document.querySelectorAll('div')).find((d) => /PREPARING MATCH/i.test(d.textContent || ''));
  return !loader && Array.from(document.querySelectorAll('button, div[class*=button]')).some((e) => /START|BEGIN|DEPLOY|ENTER/i.test(e.textContent || ''));
}, { timeout: 90000 });
for (const t of ['ENTER SECTOR', 'START', 'BEGIN', 'DEPLOY']) {
  const hit = await page.evaluate((txt) => {
    const els = Array.from(document.querySelectorAll('button, div[class*=button]'));
    const el = els.find((e) => e.textContent && e.textContent.toUpperCase().includes(txt));
    if (el) { el.click(); return true; }
    return false;
  }, t);
  if (hit) break;
}

// Catch the banner ~600ms after entering (entrance done, fully visible).
await page.waitForTimeout(600);
const midBanner = await page.evaluate(() => {
  const big = document.querySelector('#banner .big');
  const hud = document.getElementById('hud');
  const round = document.querySelector('#round');
  const cs = getComputedStyle(big);
  const r = big.getBoundingClientRect();
  return {
    bannerText: big.textContent,
    subText: document.querySelector('#banner .sub')?.textContent,
    bannerOpacity: getComputedStyle(document.getElementById('banner')).opacity,
    bigFontSizePx: cs.fontSize,
    bigColor: cs.color,
    bigWeight: cs.fontWeight,
    bigTracking: cs.letterSpacing,
    capHeightPctOfViewport: ((r.height / window.innerHeight) * 100).toFixed(2),
    roundDimmedClass: hud.classList.contains('banner-live'),
    roundOpacity: getComputedStyle(round).opacity,
  };
});
console.log('MID-BANNER:', JSON.stringify(midBanner, null, 1));
await page.screenshot({ path: '.qa/shots/hud_r2_probe_banner.png' });

// After the banner must be gone (dwell <= 1.8s + exit): class removed, corner restored.
await page.waitForTimeout(2600);
const afterBanner = await page.evaluate(() => {
  const hud = document.getElementById('hud');
  const round = document.querySelector('#round');
  const mag = document.querySelector('#ammo .mag');
  const pts = document.querySelector('#points .value');
  const name = document.querySelector('#ammo .name');
  return {
    bannerLiveClass: hud.classList.contains('banner-live'),
    roundOpacity: getComputedStyle(round).opacity,
    pointsFontPx: getComputedStyle(pts).fontSize,
    magFontPx: getComputedStyle(mag).fontSize,
    weaponNamePx: getComputedStyle(name).fontSize,
    weaponNameColor: getComputedStyle(name).color,
    panelBg: getComputedStyle(document.getElementById('points')).backgroundImage,
    hudFilterOnBanner: getComputedStyle(document.getElementById('banner')).filter,
  };
});
console.log('AFTER-BANNER:', JSON.stringify(afterBanner, null, 1));
await page.screenshot({ path: '.qa/shots/hud_r2_probe_after.png' });
await browser.close();
console.log('probe done');
