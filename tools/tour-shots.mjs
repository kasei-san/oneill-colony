// ガイドツアーの場面を見出しで指定してスクリーンショットを撮る
// 使い方: node tour-shots.mjs <出力プレフィックス> '[["旧市街",3000],["ターミナル駅",3000]]' [--night]
//   各要素は [場面の見出し, 撮るまでの待ち時間ms]。--night で先に夜にしてから撮る
import { chromium } from 'playwright';
const [out, list] = process.argv.slice(2), night = process.argv.includes('--night');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) console.log('[console]', m.text().slice(0, 300)); });
await page.goto('http://localhost:8917/index.html');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await page.keyboard.press('KeyG');
if (night) { await page.evaluate(() => window.__night()); await page.waitForTimeout(9000); }
for (const [title, wait] of JSON.parse(list)) {
  const i = await page.evaluate(t => { for (let n = 0; n < 60; n++) if (window.__demoTitle(n) === t) return n; return -1; }, title);
  if (i < 0) { console.log('not found:', title); continue; }
  await page.evaluate(i => window.__demoShot(i), i);
  await page.waitForTimeout(wait);
  console.log(i, title, 'fps', await page.textContent('#s-fps'));
  await page.screenshot({ path: `${out}-${i}.png` });
}
await browser.close();
