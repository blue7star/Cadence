/* 一次性截图：打开指定页面，用 1012 身份登录后截图。只给人工看效果用，不参与自检。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:/Users/lanmingjian/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PORT = 9334;
const BASE = 'http://localhost:8788';
const target = process.argv[2] || 'calendar';
const out = process.argv[3] || '_dev/shots/live.png';
const ME = process.argv[4] || '1012';
/* 第 5 个参数：截图前在页面里再跑一段表达式，用来看某一天 / 某个状态 */
const EXTRA = process.argv[5] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync('C:/Users/lanmingjian/AppData/Local/Temp/shot-');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
  '--window-size=1582,900', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
await sleep(1800);
let list = null;
for (let i = 0; i < 15 && !list; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
  catch { await sleep(600); }
}
if (!list) { console.error('Chrome 没起来（调试端口没响应）'); chrome.kill(); process.exit(1); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
});
await send('Page.enable');
await send('Page.navigate', { url: BASE });
await sleep(1500);
await send('Runtime.evaluate', { expression: `localStorage.setItem('pm_mvp_me','${ME}');location.reload()` });
await sleep(2200);
/* 第一次登录的人会被要求选直属上级，截图时直接跳过，看页面本身 */
await send('Runtime.evaluate', { expression: `(function(){const b=document.querySelector('[data-act=skip-mgr]');if(b)b.click();return !!b})()` });
await sleep(1400);
await send('Runtime.evaluate', { expression: `view='${target}'; if(typeof render==='function') render();` });
await sleep(1200);
if (EXTRA) {
  await send('Runtime.evaluate', { expression: EXTRA });
  await sleep(900);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
/* 第 6 个参数：只截某个区域（CSS 选择器），放大 2 倍存到同目录 *-zoom.png */
const CLIP = process.argv[6] || '';
if (CLIP) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){const el=document.querySelector(${JSON.stringify(CLIP)});if(!el)return null;const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()`,
    returnByValue: true,
  });
  const box = r.result && r.result.value;
  if (box) {
    const z = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2.5 } });
    const zp = out.replace(/\.png$/, '-zoom.png');
    fs.writeFileSync(zp, Buffer.from(z.data, 'base64'));
    console.log('saved', zp);
  } else console.log('没找到', CLIP);
}
ws.close(); chrome.kill();
