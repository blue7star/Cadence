/* 迁移后真实数据详情页截图：三视口 + 展开下属计划。
   用法：node _dev/shot-flatten.mjs <宽> <输出png> [taskId] [me] [pwd]
   只连本机调试端口，不碰用户的 Chrome；数据库由调用方用 CADENCE_DB 指向副本。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME = 'C:/Users/lanmingjian/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PORT = 9350 + Math.floor(Math.random() * 40);
const BASE = process.env.SHOT_BASE || 'http://localhost:8787';
const W = Number(process.argv[2] || 1600);
const OUT = process.argv[3] || '_dev/shots/flatten.png';
const TASK = process.argv[4] || 't7b1e0tuqm';
const ME = process.argv[5] || '1012';
const PWD = process.argv[6] || process.env.SHOT_PWD || ME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = fs.mkdtempSync('C:/Users/lanmingjian/AppData/Local/Temp/shot-flatten-');
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`,
  '--window-size=1600,1000', '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
await sleep(1800);
let list = null;
for (let i = 0; i < 20 && !list; i++) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(600); }
}
if (!list) { console.error('Chrome 没起来'); chrome.kill(); process.exit(1); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
});
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(1500);
await send('Runtime.evaluate', {
  expression: `fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({no:${JSON.stringify(ME)},password:${JSON.stringify(PWD)}})}).then(r=>r.json()).then(()=>location.reload())`
});
await sleep(3000);
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result && r.result.value;
};
await evalJs(`(function(){const b=document.querySelector('[data-act=skip-mgr]');if(b)b.click();return !!b})()`);
await sleep(800);
const opened = await evalJs(`(function(){if(typeof openTaskPage!=='function')return 'no-fn';openTaskPage(${JSON.stringify(TASK)});return 'ok'})()`);
await sleep(1500);
if (process.env.SHOT_CHECK) {
  const info = await evalJs(`(function(){const v=document.querySelector('#view');const rows=[...v.querySelectorAll('.stage')];
    const tops=rows.filter(x=>!x.classList.contains('sub'));const names=tops.map(x=>((x.querySelector('.sn')||{}).textContent||'').trim());
    return {hasLi:v.innerText.includes('李明'),hasCheng:v.innerText.includes('承接'),hasDoing:v.innerText.includes('进行中'),
      hasPct:v.innerText.includes('50%'),whoRo:v.querySelectorAll('.who-ro').length,
      edit:v.querySelectorAll('[data-act="stage-who-top"]').length,
      topRows:tops.length,subRows:rows.length-tops.length,dup:names.filter((n,i)=>n&&names.indexOf(n)!==i),
      text:v.innerText.slice(0,400)};})()`);
  console.log(JSON.stringify({ check: info }));
}
const expanded = await evalJs(`(function(){const bs=[...document.querySelectorAll('[data-act="child-plan"]')];bs.forEach(b=>b.click());return bs.length})()`);
await sleep(600);
await evalJs(`window.scrollTo(0,0)`);
await sleep(300);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
if (process.env.SHOT_DUMP) {
  const txt = await evalJs(`document.querySelector('#view').innerText`);
  console.log(JSON.stringify({ dump: txt }));
}
console.log(JSON.stringify({ saved: OUT, width: W, opened, planButtons: expanded }));
ws.close(); chrome.kill();
