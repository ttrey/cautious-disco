// Renders a blind A/B comparison HTML page to a PNG for the critic to judge.
// Usage: node .qa/abshot.mjs <ab.html> <out.png>
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const [, , abHtml, out] = process.argv;
const exe = execSync(
  `ls -d "$HOME/Library/Caches/ms-playwright"/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" | tail -1`,
)
  .toString()
  .trim();
const b = await chromium.launch({ executablePath: exe });
const p = await b.newPage({ viewport: { width: 1500, height: 820 }, deviceScaleFactor: 1 });
await p.goto('file://' + resolve(abHtml), { waitUntil: 'load' });
await p.waitForTimeout(900);
await p.screenshot({ path: out });
console.log('rendered', out);
await b.close();
