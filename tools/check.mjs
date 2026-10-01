// 動作確認用: ヘッドレス Chrome でページを開き、エラー検出・FPS・スクリーンショット・操作テストを行う
// 使い方: node tools/check.mjs <出力ディレクトリ> [--port 8917] [--presets 0,1,6] [--night] [--input]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const outDir = args[0] || '/tmp/oneill-check';
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const port = opt('--port', '8917');
const presets = opt('--presets', '0,1,6').split(',').map(Number);
const night = args.includes('--night'), input = args.includes('--input');

const fs = await import('node:fs');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
let errors = 0;
page.on('pageerror', e => { errors++; console.log('[pageerror]', e.message); });
page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) { errors++; console.log('[console]', m.text().slice(0, 400)); } });
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });

if (input) {
  const P = () => page.evaluate(() => ({ ...window.__player }));
  const a = await P();
  await page.mouse.move(640, 380); await page.mouse.down(); await page.mouse.move(700, 350, { steps: 5 }); await page.mouse.up();
  const b = await P();
  await page.keyboard.down('KeyW'); await page.waitForTimeout(600); await page.keyboard.up('KeyW');
  const c = await P();
  console.log(`input: yaw ${a.yaw !== b.yaw ? 'OK' : 'NG'} / move ${b.z !== c.z ? 'OK' : 'NG'}`);
}
await page.keyboard.press('KeyH');
if (night) { await page.evaluate(() => window.__night()); await page.waitForTimeout(9000); }
for (const p of presets) {
  await page.evaluate(i => document.querySelectorAll('#warp button')[i].click(), p);
  await page.waitForTimeout(2500);
  const fps = await page.textContent('#s-fps');
  const file = `${outDir}/${night ? 'night' : 'day'}-${p}.png`;
  await page.screenshot({ path: file });
  console.log(`preset ${p}: fps ${fps} -> ${file}`);
}
console.log(errors ? `errors: ${errors}` : 'errors: 0');
await browser.close();
process.exit(errors ? 1 : 0);
