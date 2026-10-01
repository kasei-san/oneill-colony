// ガイドツアーを速送りして、全場面が自分で次へ進み、最後に先頭へ戻ることを確かめる
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8917/index.html');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await page.keyboard.press('KeyG');
const seen = new Set(); let last = -1, wraps = 0;
for (let k = 0; k < 600 && wraps < 1; k++) {
  const i = await page.evaluate(() => window.__demo.i);
  if (i < last) wraps++;
  last = i; seen.add(i);
  await page.evaluate(() => { window.__demo.t += 3; });
  await page.waitForTimeout(80);
}
console.log('visited', seen.size, 'scenes / looped', wraps ? 'yes' : 'NO');
await browser.close();
process.exit(wraps ? 0 : 1);
