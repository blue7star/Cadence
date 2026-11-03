import { spawn } from 'node:child_process';
import fs from 'node:fs';
const CHROME='C:/Users/lanmingjian/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PORT=9335, BASE='http://localhost:8788';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const prof=fs.mkdtempSync('C:/Users/lanmingjian/AppData/Local/Temp/probe-');
const chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${prof}`,'--window-size=1582,900','about:blank'],{stdio:'ignore'});
await sleep(1800);
const list=await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise(r=>ws.addEventListener('open',r));
let seq=0; const pend=new Map();
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result);}});
const send=(method,params={})=>new Promise((res,rej)=>{const id=++seq;pend.set(id,{res,rej});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pend.has(id)){pend.delete(id);rej(new Error('timeout '+method));}},20000);});
const evalJs=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});return r.result&&r.result.value;};
await send('Page.enable');
await send('Page.navigate',{url:BASE});
await sleep(1200);
await evalJs(`localStorage.setItem('pm_mvp_me','1012');location.reload()`);
await sleep(2200);
await evalJs(`view='calendar';render();`);
await sleep(800);
const out=await evalJs(`(function(){
  const cs=[...document.querySelectorAll('.chip.cal')];
  return {today:TODAY, n:cs.length, items:cs.map(c=>{
    const id=c.dataset.id, t=S.tasks.find(x=>x.id===id);
    return {id:id, cls:c.className, txt:c.innerText.trim(), bg:getComputedStyle(c).backgroundColor,
      start:t&&t.start, end:t&&t.end, status:t&&t.status, type:t&&t.type,
      steps:(t&&t.stages||[]).map(s=>({n:s.name,d:s.date,s:s.start,e:s.end,done:s.done}))};
  })};
})()`);
console.log(JSON.stringify(out,null,1));
ws.close(); chrome.kill();
