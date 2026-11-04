/* 一次性截图：打开指定页面，用 1012 身份登录后截图。只给人工看效果用，不参与自检。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:/Users/lanmingjian/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PORT = 9334;
const BASE = 'http://localhost:8788';
const target = process.argv[2] || 'calendar';
const out = process.argv[3] || '_dev/shots/live.png';
const ME = process.argv[4] || '1012';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync('C:/Users/lanmingjian/AppData/Local/Temp/shot-');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
  '--window-size=1582,900', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
await sleep(1800);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
ws.close(); chrome.kill();
