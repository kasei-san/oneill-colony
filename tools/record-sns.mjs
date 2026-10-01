// SNS 用の縦長ダイジェスト動画（1080x1920・30fps・BGM付き）を書き出す
// 使い方: python3 -m http.server 8917 を起動した状態で  node record-sns.mjs [出力.mp4] [--fps 30]
// ページを ?sns&rec で開き、window.__frame(1/fps) で1コマずつ進めてスクリーンショットを ffmpeg に流す
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const out = args.find(a => a.endsWith('.mp4')) || 'oneill-colony-sns.mp4';
const fps = Number((args[args.indexOf('--fps') + 1]) || 30) || 30;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:8917/index.html?sns&rec');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });

const sec = await page.evaluate(() => window.__snsDuration());
const wav = out.replace(/\.mp4$/, '.wav');
fs.writeFileSync(wav, Buffer.from(await page.evaluate(s => window.__renderMusicWav(s), sec), 'base64'));
console.log(`BGM ${sec}s -> ${wav}`);

// 最初の場面に戻してから、ならし（LOD・映り込み・霧）のために時間を進めずに数コマ描く
await page.evaluate(() => window.__demoShot(0));
for (let i = 0; i < 8; i++) await page.evaluate(() => window.__frame(0));

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-i', wav,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const total = Math.round(sec * fps), t0 = Date.now();
for (let f = 0; f < total; f++) {
  await page.evaluate(dt => window.__frame(dt), 1 / fps);
  const img = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(img)) await new Promise(r => ff.stdin.once('drain', r));
  if (f % fps === 0) process.stdout.write(`\r${(f / fps).toFixed(0)}/${sec}s  (${((Date.now() - t0) / 1000).toFixed(0)}s経過)`);
}
ff.stdin.end();
await new Promise(r => ff.on('close', r));
await browser.close();
console.log(`\n→ ${out}`);
