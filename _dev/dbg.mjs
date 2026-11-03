/* 调试：复现「清空数据后新建常规规则」失败 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Users/lanmingjian/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PORT = 9334, BASE = 'http://localhost:8788';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + new URL('./chrome-dbg', import.meta.url).pathname.replace(/^\//, ''),
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });

let ver = null;
for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pend = new Map(); const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method) { events.push(m); if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }, m.sessionId).catch(() => { }); }
});
function send(method, params = {}, sessionId) {
  const id = ++seq, msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
  return new Promise((res, rej) => { pend.set(id, { res, rej }); ws.send(JSON.stringify(msg)); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)); } }, 15000); });
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable');
const js = async (e) => {
  const r = await S('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const goto = async (u) => { await S('Page.navigate', { url: u }); await sleep(900); for (let i = 0; i < 30; i++) { const st = await js(`document.readyState`).catch(() => null); if (st === 'complete') break; await sleep(200); } await sleep(500); };
const nav = async (v) => { await js(`document.querySelector('.nav-item[data-view="${v}"]').click();'ok'`); await sleep(600); };

await goto(BASE);
await js(`localStorage.clear();'ok'`); await goto(BASE);
await js(`document.querySelector('#a_no').value='1012';document.querySelector('#a_name').value='王磊';document.querySelector('[data-act=do-login]').click();'ok'`);
await sleep(1500);
if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) { await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(1000); }

await nav('settings');
await js(`document.querySelector('[data-act=reset]').click();'ok'`);
await sleep(2200);
console.log('清空后 rules/cats:', await js(`(function(){return {rules:S.rules.length, cats:S.cats.length}})()`));

await nav('today');
await js(`(function(){document.querySelector('#qTitle').value='自检临时任务';
  document.querySelector('#quickForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 'ok'})()`);
await sleep(2200);
console.log('建临时任务后:', await js(`(function(){return {has:document.querySelector('#view').innerText.includes('自检临时任务'), tasks:S.tasks.length}})()`));

await nav('routine');
console.log('常规页文本:', (await js(`document.querySelector('#view').innerText`)).replace(/\s+/g, ' ').slice(0, 200));
await js(`document.querySelector('[data-act=new-rule]').click();'ok'`);
await sleep(600);
console.log('\n--- 弹窗字段 ---');
console.log(await js(`(function(){const m=document.querySelector('#modal');
  return [...m.querySelectorAll('input,select,textarea')].map(e=>e.tagName+'#'+(e.id||'')+' val='+JSON.stringify(e.value)+' opts='+(e.options?[...e.options].map(o=>o.value+':'+o.text).join('/'):'')).join('\\n')})()`));
console.log('\n--- 弹窗按钮 ---');
console.log(await js(`(function(){return [...document.querySelectorAll('#modal [data-act]')].map(b=>b.dataset.act+':'+b.innerText.trim()).join(' | ')})()`));

await js(`document.querySelector('#r_title').value='自检规则';'ok'`);
await js(`(function(){const cy=document.querySelector('#r_cycle');cy.value='day';cy.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`);
await sleep(500);
console.log('\n--- 切到 daily 后的节点行 ---');
console.log(await js(`(function(){const r=document.querySelector('#stepRows');return r? r.innerText.replace(/\\s+/g,' '): 'no stepRows'})()`));

await js(`document.querySelector('#modal [data-act=modal-ok]').click();'ok'`);
await sleep(1500);
console.log('\n--- 点保存后 ---');
console.log('toast:', await js(`(document.querySelector('#toast')||{}).innerText || ''`));
console.log('弹窗还开着:', await js(`document.querySelector('#modalWrap').classList.contains('show')`));
console.log('S.rules:', await js(`(function(){return S.rules.map(r=>r.id+':'+r.title).join(', ')})()`));
console.log('填写值:', await js(`(function(){const r=document.querySelector('#r_title');return r?r.value:'modal closed'})()`));
const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'));
console.log('页面错误:', errs.length);
errs.slice(0, 3).forEach((e) => console.log('  ', JSON.stringify(e.params).slice(0, 300)));

ws.close(); child.kill();
setTimeout(() => process.exit(0), 300);
