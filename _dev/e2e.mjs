/* 端到端自检：直接用 CDP 驱动本机 Chromium，无第三方依赖。
   用法：node _dev/e2e.mjs [baseUrl]
   产出：_dev/shots/*.png + 控制台报告（有失败项退出码 1）
   覆盖：登录、七个页面、日历当月、下属看板、勾选持久化、拖拽改期、
        清空后的空态可用性、新建规则、快速建临时任务、载入示例数据、
        切换下属身份看承接台、JS 错误与请求失败。 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Users/lanmingjian/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
/* 每次随机挑一个调试端口：固定端口在上一轮崩溃、浏览器没退干净时会撞车。
   撞车后的表现极具误导性——新浏览器起不来，脚本连到的其实是上一轮那个卡住的页面，
   于是到处「CDP timeout」，看起来像应用坏了。 */
const PORT = 9300 + Math.floor(Math.random() * 200);
const BASE = process.argv[2] || 'http://localhost:8788';
const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 日期加减：统一走 UTC，避免本地时区把日期推前一天 */
const addDaysStr = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  · ' + info : ''}`);
}

class Cdp {
  constructor(ws, onEvent) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = []; this.onEvent = onEvent;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.method) { this.events.push(m); if (this.onEvent) this.onEvent(m); }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(msg));
      /* 20 秒在这台机器上不够：内存紧张时无头浏览器会卡住十几秒，超时太短会把慢当成错 */
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); } }, 60000);
    });
  }
}

/* 关掉上一轮遗留的自动化浏览器（只认 9333 上那个调试端口，不碰用户自己的 Chrome）。
   只发 Browser.close 不够：进程退出有延迟，端口还在，新实例抢不到就会连回这个「正在死」的会话，
   表现成随机 CDP 超时。所以关完必须等端口真正没人听，还赖着就按进程树强杀。 */
async function closeStale() {
  const alive = async () => {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); return r.ok; } catch { return false; }
  };
  if (!(await alive())) return;
  try {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (ver && ver.webSocketDebuggerUrl) {
      const ws = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise((r) => { ws.addEventListener('open', r); ws.addEventListener('error', r); });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      try { ws.close(); } catch { /* 已经断开 */ }
    }
  } catch { /* 关不掉就走下面的强杀 */ }
  for (let i = 0; i < 24 && (await alive()); i++) await sleep(250);
  if (await alive()) {
    const pid = pidOnPort(PORT);
    if (pid) killTree(pid);
    for (let i = 0; i < 24 && (await alive()); i++) await sleep(250);
  }
  console.log('（清掉了上一轮残留的自动化浏览器）');
}

/* 谁在听这个端口：Windows 用 netstat 解析，其他平台交给 lsof */
function pidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
    } else {
      const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
      return Number(out.trim().split('\n')[0]) || null;
    }
  } catch { /* 没有 netstat/lsof 就当没找到 */ }
  return null;
}

/* Windows 上 headless Chrome 会派生子进程，只 kill 主进程会留下占着端口的孤儿；
   必须按进程树杀，否则下一次 e2e 连到的是上一轮的浏览器。 */
function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid);
  } catch { /* 进程已经自己退了 */ }
}

let child = null;

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  /* 每次用独立的临时 profile，不删除任何目录（避免大批量删除被安全策略拦截） */
  const profile = `${os.tmpdir().replace(/\\/g, '/')}/wb-e2e-${Date.now()}`;
  fs.mkdirSync(profile, { recursive: true });

  /* 上一次跑崩了会把 headless 浏览器留在 9333 上：新实例抢不到端口，脚本却连到旧会话，
     于是「数据莫名不一样」——表现成断言飘。启动前先把残留的那个关掉。 */
  await closeStale();

  child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    /* 机器内存紧张时无头渲染进程容易被回收，限制堆并关掉共享内存映射能稳一些 */
    '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=768',
    '--window-size=1600,1000',
    /* E2E_SINGLE=1：单进程跑，内存吃紧的机器上少开几个渲染进程 */
    ...(process.env.E2E_SINGLE ? ['--single-process', '--no-zygote'] : []),
    'about:blank'
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  if (!ver) { console.error('Chromium 启动失败'); process.exit(2); }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  let cdp = null;
  cdp = new Cdp(ws, (m) => {
    if (m.method === 'Page.javascriptDialogOpening' && m.sessionId) {
      cdp.send('Page.handleJavaScriptDialog', { accept: true }, m.sessionId).catch(() => { });
    }
  });

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);

  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');

  const js = async (expression) => {
    const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const waitReady = async () => {
    for (let i = 0; i < 40; i++) {
      const st = await js(`({rs:document.readyState, href:location.href})`).catch(() => null);
      if (st && st.rs === 'complete' && String(st.href).startsWith('http')) return true;
      await sleep(250);
    }
    return false;
  };
  const goto = async (url) => { await S('Page.navigate', { url }); await sleep(400); await waitReady(); await sleep(500); };
  /* E2E_NO_SHOT=1：只跑断言不截图。内存紧张时无头浏览器截图会卡住，排查用。
     截图是给人看的证据，不该决定这次自检的成败：卡住就跳过并说明，断言照跑。 */
  const shot = async (name) => {
    if (process.env.E2E_NO_SHOT) return;
    try {
      const r = await Promise.race([
        S('Page.captureScreenshot', { format: 'png' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('超过 8 秒没返回')), 8000)),
      ]);
      fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.data, 'base64'));
    } catch (e) {
      console.log(`（截图 ${name} 跳过：${e.message}；版面问题请手动核对页面）`);
    }
  };
  const nav = async (view) => {
    await js(`document.querySelector('.nav-item[data-view="${view}"]').click(); 'ok'`);
    await sleep(700);
    return js(`document.querySelector('#pageTitle').textContent.trim()`);
  };
  const txt = (sel) => js(`(document.querySelector('${sel}')||{}).innerText || ''`);
  const waitFor = async (expr, ms = 6000) => {
    for (let t = 0; t < ms; t += 300) {
      if (await js(`!!(${expr})`).catch(() => false)) return true;
      await sleep(300);
    }
    return false;
  };

  /* ---------- 1 登录 ---------- */
  /* ---------- 0 固定基线：清空 1012 后重新载入示例数据 ---------- */
  await goto(BASE);
  /* 「谁登录过」是跨运行保留的：一旦跑过一次，1101 就永久变成「登录过」，
     下一轮「派给没登录过的人」就会假绿。所以基线里把激活状态也钉死：
     产品部这一组（1001 部门经理 + 1012 本人 + 四个下属）算用过；
     人力资源部 / 运营中心那两位总监没参与演示，算没用过——正好当阻断用例的对象。 */
  await js(`(async()=>{
    await fetch('/api/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({me:'1012'})});
    await fetch('/api/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({me:'1012'})});
    return 'seeded'})()`);
  {
    const ROOT0 = fileURLToPath(new URL('..', import.meta.url));
    execFileSync(process.execPath, ['--no-warnings', '-e', `
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync('data/workbench.db');
      db.prepare("UPDATE emp SET activated = CASE WHEN no IN ('1001','1002','1003','1004','1005','1012') THEN 1 ELSE 0 END").run();
      db.prepare("UPDATE emp SET last_login=NULL WHERE activated=0").run();
      /* 以前拿别人身份载入过示例数据，会在下属名下留一批 <工号>_t<N>；
         它们在「下属专项工作推进情况」里看起来像是下属自己立的，其实是重复的演示记录。
         这里是测试库，清掉；真实数据不会用这种 id 形态。 */
      db.prepare("DELETE FROM task WHERE owner_no<>'1012' AND id GLOB '[0-9][0-9][0-9][0-9]_t[0-9]*'").run();
      db.prepare("UPDATE meta SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k='rev'").run();
      db.close();`], { cwd: ROOT0, stdio: 'ignore' });
  }
  await js(`localStorage.clear(); sessionStorage.clear(); 'ok'`);
  await goto(BASE);
  check('登录页出现', await js(`!!document.querySelector('#auth.show')`));
  await js(`(function(){document.querySelector('#a_no').value='1012';
    document.querySelector('#a_name').value='王磊';
    document.querySelector('[data-act=do-login]').click();return 'ok'})()`);
  await sleep(1600);
  if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
    await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(1200);
  }
  const meName = (await txt('#meName')).trim();
  check('工号+姓名登录', meName === '王磊', '当前=' + meName);

  /* ---------- 2 七个页面 ---------- */
  for (const v of ['today', 'assign', 'routine', 'special', 'intake', 'calendar', 'settings']) {
    const title = await nav(v);
    const info = await js(`(function(){const el=document.querySelector('#view');return {
      len:(el.innerText||'').trim().length, rows:el.querySelectorAll('tr').length,
      cards:el.querySelectorAll('.card,.rule-card').length}})()`);
    check('页面可打开：' + v, info.len > 50, `${title} / ${info.len}字 / ${info.rows}行 / ${info.cards}卡片`);
    if (['today', 'assign', 'routine', 'calendar', 'settings'].includes(v)) await shot('01-' + v);
  }

  /* 导航分组定死：自己的事归「我的工作」，跟组员往来的两件归「协作」 */
  const navShape = await js(`(function(){const out=[];document.querySelectorAll('#nav > div').forEach(d=>{
    out.push(d.classList.contains('nav-group') ? '#'+d.textContent.trim() : d.dataset.view)});return out})()`);
  check('导航按「我的工作 / 协作 / 配置」分组，日历待办归自己、下派与承接归协作',
    JSON.stringify(navShape) === JSON.stringify(['#我的工作', 'today', 'calendar', 'routine', 'special', '#协作', 'assign', 'intake', '#配置', 'settings']),
    JSON.stringify(navShape));

  /* ---------- 3 日历默认当月 ---------- */
  await nav('calendar');
  const calHead = (await txt('.cal-head .m')).trim();
  const curYm = await js(`(function(){const d=new Date();return d.getFullYear()+' 年 '+(d.getMonth()+1)+' 月'})()`);
  check('日历默认停在当月', calHead === curYm, `标题=${calHead} 期望=${curYm}`);
  const calRange = await js(`(function(){
    const cells=[...document.querySelectorAll('.cal .cell')];
    const dated=cells.filter(c=>c.dataset.date).map(c=>c.dataset.date);
    const p=calCursor.split('-').map(Number);
    const prev=new Date(p[0],p[1]-2,26);
    const end=new Date(p[0],p[1],0);
    const iso=x=>x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');
    return {first:dated[0],last:dated[dated.length-1],expectFirst:iso(prev),expectLast:iso(end),
      cells:cells.length,dated:dated.length,allAfter:dated.every(d=>d>=iso(prev)),allBefore:dated.every(d=>d<=iso(end)),
      head:document.querySelector('.cal-head').innerText.replace(/\\s+/g,' ').slice(0,60)};
  })()`);
  check('月历固定从上周 26 日开始，到当月最后一天结束，26 日前空白保持星期对齐',
    calRange.first === calRange.expectFirst && calRange.last === calRange.expectLast &&
    calRange.cells % 7 === 0 && calRange.allAfter && calRange.allBefore &&
    calRange.head.includes('26日 起'),
    JSON.stringify(calRange));

  /* ---------- 4 下属看板 ---------- */
  await nav('today');
  const board = await js(`(function(){const rows=[...document.querySelectorAll('#view table tbody tr')];
    return rows.map(r=>r.innerText.replace(/\\s+/g,' ').trim())})()`);
  const isWk = await js(`(()=>{const d=new Date();const w=d.getDay();return w!==0&&w!==6})()`);
  /* 人数不写死：花名册导入用例会往库里加人，加过之后再看「4 人」就是在测脏数据 */
  const allHaveNodes = board.length >= 4 && board.every((t) => !t.includes('无节点'));
  check('下属看板每个下属都有节点', allHaveNodes, (isWk ? '工作日' : '非工作日') + ' · ' + board.join(' | ').slice(0, 300));
  if (!isWk) {
    const hint = await txt('#view');
    check('非工作日看板改为看下一个工作日', hint.includes('下个工作日'), hint.replace(/\s+/g, ' ').match(/下属常规工作推进[^|]{0,60}/)?.[0] || '');
  }

  /* ---------- 5 勾节点 → 服务端落库 → 刷新仍勾 ---------- */
  await nav('today');
  const target = await js(`(function(){
    const t=S.tasks.filter(x=>x.ownerNo===S.me.no&&x.type==='routine'&&(x.stages||[]).length>=2
      &&x.stages.some(s=>!s.done)).sort((a,b)=>a.start<b.start?-1:1)[0];
    if(!t) return {err:'没有含未完成节点的多节点实例'};
    const i=(t.stages||[]).findIndex(s=>!s.done);
    if(i<0) return {err:'节点全是已完成'};
    openTaskPage(t.id);
    const cb=document.querySelector('.sitem .cb[data-act=toggle-step][data-idx="'+i+'"]');
    if(!cb) return {err:'抽屉里没有复选框', id:t.id, idx:i};
    cb.click();
    return {id:t.id, idx:i, name:t.title};
  })()`);
  check('可勾选常规节点', !target.err, JSON.stringify(target));
  if (!target.err) {
    /* 轮询到落库为止：固定等 2.6 秒在慢盘上会误判成「没保存」 */
    let dbDone = false;
    for (let i = 0; i < 16 && dbDone !== true; i++) {
      await sleep(400);
      dbDone = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
        const t=s.tasks.find(x=>x.id==='${target.id}');
        if(!t) return 'task-missing';
        const st=(t.stages||[])[${target.idx}];
        return st ? !!st.done : (t.status==='done')})()`);
    }
    check('勾选落库（服务端 stages.done=true）', dbDone === true, `${target.name}#${target.idx} → db=${dbDone}`);
    await goto(BASE);
    await waitFor(`typeof S!=='undefined' && S && S.me && S.me.no`, 8000);
    await sleep(400);
    const reopen = await js(`(function(){openTaskPage('${target.id}');
      const cb=document.querySelector('.sitem .cb[data-idx="${target.idx}"]');
      return cb ? cb.classList.contains('on') : 'not-found'})()`);
    check('勾选状态刷新后仍在', reopen === true, String(reopen));
    await shot('14-routine-detail');
    await js(`(()=>{const b=document.querySelector('.td-head [data-act=close]');if(b)b.click();return 'ok'})()`);
  }

  /* ---------- 6 日历显示的是「这一段活」，不是父任务名 ---------- */
  await nav('calendar');
  const stageCal = await js(`(function(){
    const cells=[...document.querySelectorAll('[data-date]')];
    const dates=cells.map(c=>c.dataset.date);
    let hit=null;
    for(const t of S.tasks){
      /* 只挑自己的：下属的专项现在也可见，但那是只读的，拿来测「格子显示哪一段」会挑错对象 */
      if(t.type!=='special'||t.ownerNo!==S.me.no) continue;
      for(const st of (t.stages||[])){
        if(st.start&&st.end&&dates.includes(st.start)){ hit={t:t,st:st}; break; }
      }
      if(hit) break;
    }
    if(!hit) return {err:'当月没有带阶段区间的专项'};
    const cell=cells.find(c=>c.dataset.date===hit.st.start);
    cell.click();
    return {id:hit.t.id, parent:hit.t.title, stage:hit.st.name,
      chips:[...cell.querySelectorAll('.chip.cal')].map(e=>e.textContent)};
  })()`);
  await sleep(600);
  const dayRows = await js(`(function(){return [...document.querySelectorAll('#view .tlist .trow')]
    .map(r=>({txt:r.innerText.replace(/\\s+/g,' ').trim(), parent:(r.querySelector('.tag.parent')||{}).textContent||''}))})()`);
  check('日历格子显示阶段名（子任务），不再用父任务名占位',
    !stageCal.err && stageCal.chips.some(x => x.includes(stageCal.stage)) &&
    !stageCal.chips.some(x => x.includes(stageCal.parent)),
    JSON.stringify({ stage: stageCal.stage, chips: stageCal.chips, parent: stageCal.parent }));
  const dayRow = dayRows.find(r => r.txt.includes(stageCal.stage));
  check('右侧当天清单按阶段列，父任务降级成归属标签',
    !!dayRow && dayRow.parent.includes(stageCal.parent),
    JSON.stringify({ row: dayRow && dayRow.txt.slice(0, 90), parent: dayRow && dayRow.parent }));

  const spDetail = await js(`(function(){openTaskPage('${stageCal.id}');
    return {title:((document.querySelector('#dTitle')||{}).value||''),
      inputs:document.querySelectorAll('#view [data-field=\"cat1\"],#view [data-field=\"cat2\"]').length,
      selects:document.querySelectorAll('#view select[data-field=\"cat1\"],#view select[data-field=\"cat2\"]').length}})()`);
  await sleep(400); await shot('15-special-detail');
  check('专项详情的分类同样是手填框（不再是一级/二级下拉）',
    !!spDetail && spDetail.selects === 0 && spDetail.inputs === 2, JSON.stringify(spDetail));
  await js(`(()=>{const b=document.querySelector('.td-head [data-act=close]');if(b)b.click();return 'ok'})()`);
  await sleep(400);

  /* ---------- 6.1 非工作日不排活：专项阶段不铺到周末，常规实例不整段铺开 ---------- */
  await nav('calendar');
  const restDay = await js(`(function(){
    calCursor=monthStart(TODAY); selDay=TODAY; view='calendar'; render();
    const cells=[...document.querySelectorAll('[data-date]')];
    const cell=cells.find(c=>!isWorkday(c.dataset.date)&&c.dataset.date>=TODAY);
    if(!cell) return {err:'当前视图没有非工作日'};
    const date=cell.dataset.date;
    const chips=cell.querySelectorAll('.chip.cal').length;
    cell.click();
    return {date:date, chips:chips,
      coveredSpecial:S.tasks.some(t=>isMineTask(t)&&t.type==='special'&&(t.stages||[]).some(s=>!s.done&&s.start&&s.end&&s.start<=date&&s.end>=date)),
      coveredRoutine:S.tasks.some(t=>isMineTask(t)&&t.type==='routine'&&(t.stages||[]).length&&t.start<=date&&t.end>=date)};
  })()`);
  await sleep(500);
  const restPanel = await js(`(function(){
    return {rows:[...document.querySelectorAll('#view .tlist .trow')].map(r=>r.innerText.replace(/\\s+/g,' ').trim()),
      empty:(document.querySelector('#view .tlist .empty')||{}).textContent||''};
  })()`);
  await shot('16-restday');
  check('非工作日不铺专项阶段，常规实例也不整段冒出来（格子和右栏都空）',
    !restDay.err && restDay.coveredSpecial === true && restDay.coveredRoutine === true &&
    restDay.chips === 0 && restPanel.rows.length === 0 && restPanel.empty.includes('休息日'),
    JSON.stringify({ restDay, restPanel }));

  /* ---------- 6.2 阶段能就地改名称和日期，不用删了重建 ---------- */
  const stOpen = await js(`(function(){
    const t=S.tasks.find(x=>x.type==='special'&&x.ownerNo===S.me.no&&(x.stages||[]).length>=2&&(x.stages||[]).every(s=>s.start&&s.end));
    if(!t) return {err:'没有可编辑阶段的专项'};
    openTaskPage(t.id);
    const row=[...document.querySelectorAll('#view .stage')].find(r=>r.querySelector('[data-act=stage-edit]'));
    if(!row) return {err:'阶段行没有「改」入口'};
    row.querySelector('[data-act=stage-edit]').click();
    const box=document.querySelector('#view .sedit');
    if(!box) return {err:'点了「改」没展开编辑框'};
    const i=Number(box.dataset.idx), s=t.stages[i];
    return {id:t.id, idx:i, oldName:s.name, oldStart:s.start, oldEnd:s.end,
      shown:(box.querySelector('.sname')||{}).value||'', fields:box.querySelectorAll('input').length};
  })()`);
  await sleep(400); await shot('16b-stage-edit');
  check('阶段行有编辑入口，展开的框里名称和起止日期都能改',
    !stOpen.err && stOpen.fields === 3 && stOpen.shown === stOpen.oldName,
    JSON.stringify(stOpen));

  const stBad = stOpen.err ? {err: 'skip'} : await js(`(function(){
    const box=document.querySelector('#view .sedit');
    const s=S.tasks.find(x=>x.id==='${stOpen.id}').stages[${stOpen.idx != null ? stOpen.idx : 0}];
    box.querySelector('.sname').value='不该保存的名字';
    box.querySelector('.sst').value=s.end; box.querySelector('.sen').value=s.start;
    box.querySelector('[data-act=stage-save]').click();
    return {msg:(document.querySelector('#toast')||{}).textContent||'', name:s.name};
  })()`);
  await sleep(300);
  check('结束早于开始时拦下并说明原因，改动不落库',
    !stOpen.err && stBad.msg.includes('结束日期不能早于开始日期') && stBad.name === stOpen.oldName,
    JSON.stringify(stBad));

  const stFix = stOpen.err ? {err: 'skip'} : await js(`(function(){
    const box=document.querySelector('#view .sedit');
    const s=S.tasks.find(x=>x.id==='${stOpen.id}').stages[${stOpen.idx != null ? stOpen.idx : 0}];
    box.querySelector('.sname').value='改名后的阶段';
    box.querySelector('.sst').value=addDays(s.start,1);
    box.querySelector('.sen').value=addDays(s.end,-1);
    box.querySelector('[data-act=stage-save]').click();
    return {msg:(document.querySelector('#toast')||{}).textContent||''};
  })()`);
  await sleep(900);
  const stAfter = stOpen.err ? null : await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
    const t=s.tasks.find(x=>x.id==='${stOpen.id}');const st=t.stages[${stOpen.idx != null ? stOpen.idx : 0}];
    return {name:st.name, start:st.start, end:st.end}})()`);
  check('改完立刻落库：名称、开始、结束三样都按新值存下来',
    !!stAfter && stAfter.name === '改名后的阶段' &&
    stAfter.start === addDaysStr(stOpen.oldStart, 1) && stAfter.end === addDaysStr(stOpen.oldEnd, -1),
    JSON.stringify({ before: { name: stOpen.oldName, start: stOpen.oldStart, end: stOpen.oldEnd }, after: stAfter }));
  /* 还原，后面几条用例还要用这份数据 */
  if (!stOpen.err) {
    await js(`(function(){const t=S.tasks.find(x=>x.id==='${stOpen.id}');const s=t.stages[${stOpen.idx}];
      s.name=${JSON.stringify(stOpen.oldName)};s.start=${JSON.stringify(stOpen.oldStart)};s.end=${JSON.stringify(stOpen.oldEnd)};
      save();return 1})()`);
    await js(`(()=>{const b=document.querySelector('.td-head [data-act=close]');if(b)b.click();return 'ok'})()`);
    await sleep(500);
  }
  await nav('calendar');
  await js(`(function(){selDay=TODAY;calCursor=monthStart(TODAY);render();return 1})()`);
  await sleep(300);

  /* ---------- 7 拖动改期：能改的整体平移，不能改的说清原因 ---------- */
  const drag = await js(`(function(){
    const chips=[...document.querySelectorAll('[data-drag]')].map(e=>({el:e,d:JSON.parse(e.dataset.drag)})).filter(c=>c.d.s<0);
    const hit=chips.map(c=>({c:c, t:S.tasks.find(x=>x.id===c.d.id)}))
      .find(o=>o.t&&isMineTask(o.t)&&o.t.type!=='routine'&&!(o.t.stages||[]).length&&o.t.status!=='done'&&o.t.end>=TODAY);
    if(!hit) return {err:'日历里没有可拖的普通任务'};
    const t=hit.t, chip=hit.c.el;
    const to=[...document.querySelectorAll('[data-date]')].filter(c=>c.dataset.date>t.end&&isWorkday(c.dataset.date))[0];
    if(!to) return {err:'没有合适的未来工作日'};
    const before={start:t.start,end:t.end};
    const dt=new DataTransfer();
    chip.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
    to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
    to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    return {id:t.id, title:t.title, before:before, to:to.dataset.date};
  })()`);
  await sleep(1800);
  const afterDrag = drag.err ? null : await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
    const t=s.tasks.find(x=>x.id==='${drag.id}');return t?{start:t.start,end:t.end}:null})()`);
  const dayGap = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  const beforeGap = drag.err ? -99 : dayGap(drag.before.start, drag.before.end);
  check('拖到未来工作日：整段平移，工期天数不变',
    !drag.err && !!afterDrag && afterDrag.start === drag.to && dayGap(afterDrag.start, afterDrag.end) === beforeGap,
    JSON.stringify({ title: drag.title, before: drag.before, to: drag.to, after: afterDrag }));

  const pastDrag = await js(`(function(){
    const t=S.tasks.find(x=>x.id==='${drag.id}');
    if(!t) return {err:'任务不见了'};
    const chip=[...document.querySelectorAll('[data-drag]')].find(e=>{const d=JSON.parse(e.dataset.drag);return d.id===t.id&&d.s<0});
    if(!chip) return {err:'卡片不在日历里'};
    const cell=[...document.querySelectorAll('[data-date]')].filter(c=>c.dataset.date<TODAY)
      .sort((a,b)=>a.dataset.date<b.dataset.date?1:-1)[0];
    if(!cell) return {err:'当月没有过去的日期'};
    const dt=new DataTransfer();
    chip.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
    cell.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
    const hint=(document.querySelector('#dragHint')||{}).textContent||'';
    const no=cell.classList.contains('drop-no');
    cell.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    return {date:cell.dataset.date, hint:hint, no:no};
  })()`);
  await sleep(1200);
  const afterPast = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
    const t=s.tasks.find(x=>x.id==='${drag.id}');return t?{start:t.start,end:t.end}:null})()`);
  check('拖到过去被拦下：当场说明原因，数据不动',
    !pastDrag.err && pastDrag.no && pastDrag.hint.includes('不能拖到过去') && !!afterPast && afterPast.start === afterDrag.start,
    JSON.stringify({ past: pastDrag, after: afterPast }));

  const stageDrag = await js(`(function(){
    const t=S.tasks.find(x=>x.type==='special'&&x.ownerNo===S.me.no&&(x.stages||[]).length>=2&&x.stages.every(s=>s.start&&s.end));
    if(!t) return {err:'没有可测的专项'};
    const i=t.stages.length-1, st=t.stages[i], prev=t.stages[i-1];
    const chip=[...document.querySelectorAll('[data-drag]')].find(e=>{const d=JSON.parse(e.dataset.drag);return d.id===t.id&&d.s===i});
    if(!chip) return {err:'日历里没有这个阶段的卡片'};
    const cell=[...document.querySelectorAll('[data-date]')]
      .filter(c=>c.dataset.date<st.start&&c.dataset.date<=prev.end&&c.dataset.date>=TODAY)
      .sort((a,b)=>a.dataset.date<b.dataset.date?-1:1)[0];
    if(!cell) return {err:'找不到能触发重叠的可见日期'};
    const dt=new DataTransfer();
    chip.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
    cell.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
    const hint=(document.querySelector('#dragHint')||{}).textContent||'';
    const no=cell.classList.contains('drop-no');
    cell.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    return {id:t.id, i:i, name:st.name, hint:hint, no:no, before:{start:st.start,end:st.end}};
  })()`);
  await sleep(1200);
  const stageAfter = stageDrag.err ? null : await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
    const t=s.tasks.find(x=>x.id==='${stageDrag.id}');
    if(!t) return null; const st=(t.stages||[])[${stageDrag.i}]; return st?{start:st.start,end:st.end}:null})()`);
  check('阶段不能压到前一段：拦下并说明和哪一段撞了，日期不变',
    !stageDrag.err && stageDrag.no && stageDrag.hint.includes('重叠') && !!stageAfter && stageAfter.start === stageDrag.before.start,
    JSON.stringify({ drag: stageDrag, after: stageAfter }));

  const routineDrag = await js(`(function(){
    const chips=[...document.querySelectorAll('[data-drag]')].map(e=>({el:e,d:JSON.parse(e.dataset.drag)}));
    const hit=chips.map(c=>({c:c,t:S.tasks.find(x=>x.id===c.d.id)}))
      .find(o=>o.t&&o.t.type==='routine'&&o.t.status!=='done'&&(o.c.d.s<0||!(o.t.stages[o.c.d.s]||{}).done));
    if(!hit) return {err:'日历里没有未完成的常规卡片'};
    const cell=[...document.querySelectorAll('[data-date]')].find(c=>!isWorkday(c.dataset.date)&&c.dataset.date>=TODAY);
    if(!cell) return {err:'当前视图没有非工作日'};
    const dt=new DataTransfer();
    hit.c.el.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
    cell.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
    const hint=(document.querySelector('#dragHint')||{}).textContent||'';
    const no=cell.classList.contains('drop-no');
    cell.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
    return {title:hit.t.title, to:cell.dataset.date, hint:hint, no:no};
  })()`);
  await sleep(900);
  check('常规工作拖不到非工作日：提示去改规则',
    !routineDrag.err && routineDrag.no && routineDrag.hint.includes('工作日'), JSON.stringify(routineDrag));

  /* ---------- 8 列表里直接改状态（暂缓不用进详情） ---------- */
  const qst = await js(`(function(){
    const t0=S.tasks.find(x=>isMineTask(x)&&x.type!=='routine'&&!(x.stages||[]).length&&x.status==='todo'&&isWorkday(x.start));
    if(!t0) return {err:'没有可改状态的普通任务'};
    selDay=t0.start; view='calendar'; render();
    const sel=document.querySelector('#view .tlist .qst[data-id="'+t0.id+'"]');
    if(!sel) return {err:'当天清单里没有状态下拉', title:t0.title};
    const opt=[...sel.options].map(o=>o.textContent);
    sel.value='paused';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return {id:t0.id, title:t0.title, opt:opt};
  })()`);
  let qstDb = qst.err ? null : 'pending';
  for (let i = 0; i < 16 && qstDb === 'pending'; i++) {
    await sleep(400);
    qstDb = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
      const t=s.tasks.find(x=>x.id==='${qst.id}');return t?t.status:null})()`);
  }
  check('任务行里直接选「暂缓」即可落库，不用点进详情',
    !qst.err && qst.opt.includes('暂缓') && qstDb === 'paused', JSON.stringify({ row: qst.title, opt: qst.opt, db: qstDb }));

  /* 常规实例也能直接改状态（今天做不完就挂暂缓，不该逼人进详情） */
  const rq = await js(`(function(){
    const t0=S.tasks.find(x=>x.type==='routine'&&isMineTask(x)&&x.status!=='done'&&x.start===TODAY);
    if(!t0) return {err:'今天没有未完成的常规实例'};
    selDay=TODAY; view='calendar'; render();
    const sel=document.querySelector('#view .tlist .qst[data-id="'+t0.id+'"]');
    if(!sel) return {err:'常规行没有状态下拉', title:t0.title};
    const opt=[...sel.options].map(o=>o.textContent);
    sel.value='paused';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return {id:t0.id, title:t0.title, opt:opt};
  })()`);
  let rqDb = rq.err ? null : 'pending';
  for (let i = 0; i < 16 && rqDb === 'pending'; i++) {
    await sleep(400);
    rqDb = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
      const t=s.tasks.find(x=>x.id==='${rq.id}');return t?t.status:null})()`);
  }
  check('常规任务也能在列表里设状态（暂缓落库）',
    !rq.err && rq.opt.includes('暂缓') && rqDb === 'paused', JSON.stringify({ row: rq.title, db: rqDb, err: rq.err }));

  /* 再挑一条设成进行中，凑齐四种状态给视觉断言用 */
  const rd = await js(`(function(){
    const t0=S.tasks.find(x=>x.type==='routine'&&isMineTask(x)&&x.status==='todo'&&x.start===TODAY);
    if(!t0) return {err:'没有第二条待开展的常规实例'};
    view='calendar'; selDay=TODAY; render();
    const sel=document.querySelector('#view .tlist .qst[data-id="'+t0.id+'"]');
    if(!sel) return {err:'没找到状态下拉'};
    sel.value='doing'; sel.dispatchEvent(new Event('change',{bubbles:true}));
    return {id:t0.id, title:t0.title};
  })()`);
  await sleep(1400);

  /* 日历：来源保留最初的底色/字色，状态用左色条 + 右短文字，逾期只用红框 */
  const calVis = await js(`(function(){
    const chips=[...document.querySelectorAll('.chip.cal')];
    const one=k=>chips.find(c=>c.classList.contains('s-'+k)&&!c.classList.contains('overdue'));
    const bar=c=>c?getComputedStyle(c,'::before').backgroundColor:'none';
    const text=c=>c?((c.querySelector('.st')||{}).textContent||''):'missing';
    const deco=c=>c?getComputedStyle(c.querySelector('.lbl')).textDecorationLine:'none';
    const legend=[...document.querySelectorAll('.cal-legend span')].map(s=>s.textContent.trim());
    return {has:{done:!!one('done'),doing:!!one('doing'),paused:!!one('paused'),todo:!!one('todo')},
      bar:{todo:bar(one('todo')),doing:bar(one('doing')),paused:bar(one('paused')),done:bar(one('done'))},
      text:{todo:text(one('todo')),doing:text(one('doing')),paused:text(one('paused')),done:text(one('done'))},
      barWidth:one('doing')?getComputedStyle(one('doing'),'::before').width:'0px',
      doneDeco:deco(one('done')), legend:legend};
  })()`);
  const cv=calVis;
  check('状态用左侧色条区分：待开展灰、进行中蓝、暂缓橙、已完成绿',
    cv.has.done && cv.has.doing && cv.has.paused && cv.has.todo && cv.barWidth === '3px' &&
    new Set([cv.bar.todo, cv.bar.doing, cv.bar.paused, cv.bar.done]).size === 4,
    JSON.stringify(cv.bar));
  check('状态还有短文字：进行中 / 暂缓 / 已完成直接写明，已完成标题划掉',
    cv.text.todo === '' && cv.text.doing === '进行中' && cv.text.paused === '暂缓' &&
    cv.text.done === '已完成' && cv.doneDeco.includes('line-through'),
    JSON.stringify({ text: cv.text, deco: cv.doneDeco }));
  const srcVis = await js(`(function(){
    /* 当月不一定四种来源都有，用离屏探针核对四套固定配色，避免演示数据变化造成假红 */
    const host=document.createElement('div'); host.style.display='none'; document.body.append(host);
    const out={};
    for(const k of ['assign','routine','special','temp']){
      const c=document.createElement('span'); c.className='chip cal '+k; host.append(c);
      const g=getComputedStyle(c); out[k]={bg:g.backgroundColor,color:g.color};
    }
    host.remove(); return out;
  })()`);
  const srcExpected={
    assign:{bg:'rgb(238, 244, 255)',color:'rgb(29, 78, 216)'},
    routine:{bg:'rgb(232, 247, 244)',color:'rgb(11, 122, 109)'},
    special:{bg:'rgb(243, 237, 255)',color:'rgb(109, 40, 217)'},
    temp:{bg:'rgb(255, 244, 227)',color:'rgb(180, 83, 9)'}};
  check('来源恢复最初的底色和字色：下派蓝、常规青、专项紫、临时橙',
    Object.keys(srcExpected).every(k=>!!srcVis[k]&&srcVis[k].bg===srcExpected[k].bg&&srcVis[k].color===srcExpected[k].color),
    JSON.stringify(srcVis));
  check('图例分开写来源与状态，并列出已逾期',
    cv.legend.includes('来源') && cv.legend.includes('状态') &&
    ['下派','常规','专项','临时'].every(x=>cv.legend.includes(x)) &&
    ['待开展','进行中','暂缓','已完成','已逾期'].every(x=>cv.legend.includes(x)),
    JSON.stringify(cv.legend));

  /* 逾期 = 红框 + 短文字，不盖住来源底色，也不丢进行中状态 */
  const lateOne = await js(`(function(){
    const t=S.tasks.find(x=>x.type!=='routine'&&!(x.stages||[]).length&&x.status!=='done'&&isMineTask(x));
    if(!t) return {err:'没有可用任务'};
    t.start=addDays(TODAY,-3); t.end=addDays(TODAY,-1); t.status='doing';
    save(); calCursor=monthStart(TODAY); selDay=TODAY; view='calendar'; render();
    return {id:t.id, title:t.title, type:t.type};
  })()`);
  await sleep(900);
  const lateVis = lateOne.err ? null : await js(`(function(){
    const c=document.querySelector('.chip.cal[data-id="${lateOne.id}"]');
    if(!c) return {err:'日历里没有这张卡'};
    const g=getComputedStyle(c);
    const done=(()=>{const d=[...document.querySelectorAll('.chip.cal.s-done')][0];
      return d?{late:d.classList.contains('overdue'),border:getComputedStyle(d).borderColor}:null})();
    return {bg:g.backgroundColor, border:g.borderColor, bar:getComputedStyle(c,'::before').backgroundColor,
      late:c.classList.contains('overdue'), mark:((c.querySelector('.st')||{}).textContent||''), done:done};
  })()`);
  check('逾期用红框和「逾期」提示，来源底色与进行中色条都保留',
    !lateOne.err && !!lateVis && !lateVis.err && lateVis.late === true &&
    lateVis.bg === srcExpected[lateOne.type].bg && lateVis.border === 'rgb(220, 38, 38)' &&
    lateVis.mark === '逾期' && lateVis.bar === cv.bar.doing,
    JSON.stringify({ late: lateOne, vis: lateVis }));
  check('已完成的任务不会因为日期过了就变红框',
    !!lateVis && !!lateVis.done && lateVis.done.late === false && lateVis.done.border !== 'rgb(220, 38, 38)',
    JSON.stringify(lateVis && lateVis.done));
  await shot('17-cal-status');
  await js(`(()=>{const l=document.querySelector('.cal-legend');if(l)l.scrollIntoView({block:'end'});return 1})()`);
  await sleep(400);
  const legendVis = await js(`(function(){
    const sources=[...document.querySelectorAll('.cal-legend .lgsrc')].map(x=>getComputedStyle(x).backgroundColor);
    const states=[...document.querySelectorAll('.cal-legend .lgst')].map(x=>getComputedStyle(x).backgroundColor);
    const late=document.querySelector('.cal-legend .lglate');
    return {sources:sources, states:states, lateBorder:late?getComputedStyle(late).borderColor:'none'};
  })()`);
  await shot('18-legend');
  check('图例用色块表来源、竖条表状态、红框表逾期',
    legendVis.sources.length === 4 && new Set(legendVis.sources).size === 4 &&
    legendVis.states.length === 4 && new Set(legendVis.states).size === 4 &&
    legendVis.lateBorder === 'rgb(220, 38, 38)',
    JSON.stringify(legendVis));
  await js(`(()=>{window.scrollTo(0,0);return 1})()`);

  /* ---------- 9 分类改成手填 ---------- */
  const catTest = await js(`(function(){
    openNewTask('temp');
    const modal=document.querySelector('#modal');
    const c1=modal.querySelector('[data-field="cat1"]'), c2=modal.querySelector('[data-field="cat2"]');
    if(!c1||!c2) return {err:'分类不是文本框'};
    const sels=modal.querySelectorAll('select[data-field="cat1"],select[data-field="cat2"]').length;
    modal.querySelector('#f_title').value='E2E 手填分类';
    c1.value='自定义一级'; c2.value='自定义二级';
    document.querySelector('[data-act=modal-ok]').click();
    return {sels:sels};
  })()`);
  await sleep(1800);
  const catDb = catTest.err ? null : await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
    const t=s.tasks.find(x=>x.title==='E2E 手填分类');return t?{cat1:t.cat1,cat2:t.cat2}:null})()`);
  check('新建任务时分类是查手填文本框，写什么存什么',
    !catTest.err && catTest.sels === 0 && !!catDb && catDb.cat1 === '自定义一级' && catDb.cat2 === '自定义二级',
    JSON.stringify({ catTest, catDb }));

  /* ---------- 7 清空后的空态仍然可用 ---------- */
  await nav('settings');
  await js(`document.querySelector('[data-act=reset]').click();'ok'`);
  await sleep(2200);
  await nav('today');
  const emptyHint = await txt('#view');
  check('清空后今日待办有空态提示', emptyHint.includes('还没有安排') || emptyHint.includes('暂无'), emptyHint.replace(/\s+/g, ' ').slice(0, 120));

  await js(`(function(){document.querySelector('#qTitle').value='自检临时任务';
    document.querySelector('#quickForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return 'ok'})()`);
  await sleep(2200);
  const tempOk = (await txt('#view')).includes('自检临时任务');
  check('空态下可快速建临时任务', tempOk);

  await nav('routine');
  await js(`(function(){const bs=[...document.querySelectorAll('[data-act=new-rule]')];
    const b=bs.find(x=>x.offsetParent!==null)||bs[0]; b.click(); return 'ok'})()`);
  const hasForm = await waitFor(`document.querySelector('#r_title')`, 4000);
  let ruleDiag = '';
  if (hasForm) {
    await js(`(function(){document.querySelector('#r_title').value='自检规则';
      const cy=document.querySelector('#r_cycle'); cy.value='day'; cy.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`);
    await sleep(600);
    await js(`document.querySelector('#modal [data-act=modal-ok]').click();'ok'`);
    /* 规则要由服务端生成实例，轮询到出现为止，别用固定等待赌命 */
    let created = false;
    for (let i = 0; i < 20 && !created; i++) {
      await sleep(400);
      created = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
        return (s.rules||[]).some(x=>x.title==='自检规则')})()`);
    }
    /* 失败时要有可判的现场：弹窗还在不在、toast 说什么、本地是否已有这条规则 */
    ruleDiag = JSON.stringify(await js(`(function(){return {
      toast:(document.querySelector('#toast')||{}).textContent||'',
      modalOpen:document.querySelector('#modalWrap').classList.contains('show'),
      local:(S.rules||[]).map(r=>r.title), sync:(document.querySelector('#syncState')||{}).textContent||''}})()`));
  } else {
    ruleDiag = '弹窗未打开 / 常规页文本: ' + (await txt('#view')).replace(/\s+/g, ' ').slice(0, 120);
  }
  /* 规则按周期分页签，切到「日常规」再断言 */
  await js(`(()=>{const b=document.querySelector('[data-act=rtab][data-tab=day]');if(b)b.click();return 'ok'})()`);
  await sleep(700);
  const ruleInUi = (await txt('#view')).includes('自检规则');
  const ruleInDb = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
    const ru=(s.rules||[]).find(x=>x.title==='自检规则');
    if(!ru) return {rule:false, inst:0};
    return {rule:true, inst:(s.tasks||[]).filter(t=>t.routineId===ru.id).length}})()`);
  check('空态下可新建常规规则', ruleInUi && ruleInDb.rule && ruleInDb.inst > 0,
    ruleDiag || `界面=${ruleInUi} 库=${JSON.stringify(ruleInDb)}`);

  await goto(BASE);
  await waitFor(`typeof S!=='undefined' && S && S.me && S.me.no`, 8000);
  await sleep(400);
  const persistedTask = await js(`(function(){return document.body.innerText.includes('自检临时任务')})()`);
  const persistDiag = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
    return {view:(typeof view!=='undefined'?view:'?'), login:!!document.querySelector('#auth.show'),
      inDb:(s.tasks||[]).some(t=>t.title==='自检临时任务'),
      localMe:(window.S&&S.me?S.me.no:null),
      lsMe:localStorage.getItem('pm_mvp_me')}})()`);
  await nav('routine');
  await js(`(()=>{const b=document.querySelector('[data-act=rtab][data-tab=day]');if(b)b.click();return 'ok'})()`);
  await sleep(600);
  const ruleAlive = (await txt('#view')).includes('自检规则');
  check('新建数据刷新后仍在', persistedTask && ruleAlive, `任务=${persistedTask} 规则=${ruleAlive} 现场=${JSON.stringify(persistDiag)}`);

  /* ---------- 7.5 删除 = 彻底删除：规则与它的安排一起清掉 ---------- */
  const delDlg = await js(`(async()=>{
    const card=[...document.querySelectorAll('.rule-card')].find(c=>c.innerText.includes('自检规则'));
    if(!card) return {err:'没有规则卡片'};
    card.querySelector('[data-act=rule-del]').click();
    await new Promise(r=>setTimeout(r,300));
    const m=document.querySelector('#modal');
    const t=m?m.innerText.replace(/\\s+/g,' '):'';
    const ok=m&&m.querySelector('[data-act=modal-ok]');
    if(ok) ok.click();
    return {dialog:t.slice(0,120)};
  })()`);
  let goneDb = { rules: -1, inst: -1 };
  for (let i = 0; i < 20 && goneDb.rules !== 0; i++) {
    await sleep(400);
    goneDb = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
      return {rules:s.rules.filter(x=>x.title==='自检规则').length,
        inst:s.tasks.filter(t=>t.title==='自检规则').length}})()`);
  }
  check('删除规则 = 连同安排彻底清掉',
    /删除/.test(String(delDlg.dialog || '')) && goneDb.rules === 0 && goneDb.inst === 0,
    JSON.stringify({ dlg: delDlg, db: goneDb }).slice(0, 240));

  /* ---------- 8 载入示例数据恢复 ---------- */
  await nav('settings');
  await js(`document.querySelector('[data-act=reset]').click();'ok'`);
  await sleep(2000);
  await js(`document.querySelector('[data-act=load-demo]').click();'ok'`);
  /* 示例数据要生成几百条实例，别用固定等待；等到数据真回来再断言 */
  for (let i = 0; i < 30; i++) {
    const n = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
      return (s.tasks||[]).length})()`);
    if (n > 0) break;
    await sleep(500);
  }
  await nav('today');
  let restored = { rows: 0, sub: 0 };
  for (let i = 0; i < 12 && restored.rows < 1; i++) {
    await sleep(500);
    restored = await js(`(function(){return {rows:document.querySelectorAll('.trow').length,
      sub:document.querySelectorAll('#view table tbody tr').length}})()`);
  }
  check('载入示例数据可用', restored.rows >= 1 && restored.sub >= 1, JSON.stringify(restored));
  await shot('02-after-restore');

  /* ---------- 8.5 停用 = 只停今后，已有安排保留；不设「清空实例」按钮 ---------- */
  await nav('routine');
  await js(`(()=>{const b=document.querySelector('[data-act=rtab][data-tab=day]');if(b)b.click();return 'ok'})()`);
  await sleep(700);
  const beforeStop = await js(`(function(){
    const card=[...document.querySelectorAll('.rule-card')].find(c=>c.innerText.includes('部门晨会'));
    if(!card) return {err:'没有部门晨会卡片', cards:[...document.querySelectorAll('.rule-card')].map(c=>c.innerText.slice(0,20))};
    const noClearBtn = !card.querySelector('[data-act=rule-clear]');
    const r=S.rules.find(x=>x.title==='部门晨会');
    if(!r) return {err:'S.rules 里没有部门晨会'};
    const mine=S.tasks.filter(t=>t.routineId===r.id);
    const n=mine.length;
    const kept=mine.filter(t=>t.status==='done'||(t.planDate||t.start)<=TODAY).length;
    card.querySelector('[data-act=rule-toggle]').click();
    return {id:r.id, n, kept, future:n-kept, noClearBtn};
  })()`);
  check('常规卡上没有「清空实例」按钮', beforeStop.noClearBtn === true, JSON.stringify(beforeStop).slice(0, 200));

  let afterStop = { active: 'skipped', left: -1 };
  if (beforeStop.id) {
    /* 停用要重排实例，轮询到真的停用为止 */
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      afterStop = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
        const rule=s.rules.find(x=>x.id==='${beforeStop.id}');
        return {active:rule?rule.active:'rule-missing', left:s.tasks.filter(t=>t.routineId==='${beforeStop.id}').length}})()`);
      if (afterStop.active === false) break;
    }
  }
  check('停用只停今后：今天及以前保留，明天以后撤掉',
    !!beforeStop.id && beforeStop.n > 0 && beforeStop.future > 0 &&
    afterStop.active === false && afterStop.left === beforeStop.kept,
    `停用前 ${beforeStop.n} 条（其中未来 ${beforeStop.future}）→ 应留 ${beforeStop.kept}，实际 ${JSON.stringify(afterStop)}`);

  if (beforeStop.id) {
    await goto(BASE);
    await waitFor(`typeof S!=='undefined' && S && S.me && S.me.no`, 8000);
    await sleep(400); await nav('routine');
    await js(`(()=>{const b=document.querySelector('[data-act=rtab][data-tab=day]');if(b)b.click();return 'ok'})()`);
    await sleep(700);
    const stopCard = await js(`(function(){const c=[...document.querySelectorAll('.rule-card')].find(x=>x.innerText.includes('部门晨会'));
      return c?c.innerText.replace(/\\s+/g,' ').slice(0,220):'card-missing'})()`);
    check('停用状态刷新后仍显示「已停用 · 已有安排保留」',
      /已停用/.test(stopCard) && /保留/.test(stopCard) && /启用/.test(stopCard), String(stopCard).slice(0, 170));

    /* 恢复启用，保证后续用例有数据 */
    await js(`(function(){const c=[...document.querySelectorAll('.rule-card')].find(x=>x.innerText.includes('部门晨会'));
      if(!c) return 'no-card'; c.querySelector('[data-act=rule-toggle]').click(); return 'ok'})()`);
    let reOn = { active: 'pending', n: 0 };
    for (let i = 0; i < 20 && reOn.active !== true; i++) {
      await sleep(500);
      reOn = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
        const rule=s.rules.find(x=>x.id==='${beforeStop.id}');
        return {active:rule?rule.active:'missing', n:s.tasks.filter(t=>t.routineId==='${beforeStop.id}').length}})()`);
    }
    check('重新启用后恢复生成', reOn.active === true && reOn.n > afterStop.left, JSON.stringify(reOn));
  }

  /* ---------- 8.5 版本号与更新记录 ---------- */
  await nav('today');
  const meta = await js(`(async()=>{const r=await fetch('/api/version');return r.json()})()`);
  check('/api/version 带上本次更新内容', !!(meta.changelog && meta.changelog.items && meta.changelog.items.length),
    'semver=' + meta.semver + ' title=' + ((meta.changelog || {}).title || '无'));
  const chip = await js(`(function(){const c=document.querySelector('#appVer');
    return {hidden:c.hidden,text:c.textContent.trim()}})()`);
  check('顶栏常驻版本号', !chip.hidden && chip.text === 'v' + meta.semver,
    JSON.stringify(chip) + ' 期望 v' + meta.semver);

  await js(`document.querySelector('#appVer').click();'ok'`);
  const dlgOpen = await waitFor(`document.querySelector('.cv-overlay')`);
  await waitFor(`document.querySelectorAll('.cv-ver-h').length >= 2`, 4000);   // 历史是异步拉的
  const hist = await js(`(function(){const o=document.querySelector('.cv-overlay'); if(!o) return null;
    return {title:o.querySelector('.cv-title').innerText.replace(/\\s+/g,' '),
      versions:[...o.querySelectorAll('.cv-ver-h')].map(x=>x.innerText.replace(/\\s+/g,' ')),
      curBadged:!!o.querySelector('.cv-ver-h .cv-badge')}})()`);
  check('点版本号打开历次更新', dlgOpen && !!hist && hist.versions.length >= 2, JSON.stringify(hist).slice(0, 220));
  const histApi = await js(`(async()=>{const r=await fetch('/api/changelog');const d=await r.json();
    return d.versions.map(v=>v.version)})()`);
  check('历次更新倒序、当前版本带徽章',
    !!hist && hist.versions.length === histApi.length && histApi.length >= 2
      && hist.versions.every((t, i) => t.includes(histApi[i])) && hist.curBadged
      && hist.versions[0].includes(meta.semver),
    JSON.stringify({ ui: hist && hist.versions, api: histApi }));
  await sleep(350);   // 等淡入动画结束，否则截到半透明中间帧
  await shot('09-changelog-history');  await js(`document.querySelector('.cv-overlay .btn.primary').click();'ok'`);
  check('点「知道了」关闭弹窗', !(await js(`!!document.querySelector('.cv-overlay')`)));

  await js(`localStorage.setItem('cadence_seen_version','0.0.9');'ok'`);
  await goto(BASE);
  const autoOpen = await waitFor(`document.querySelector('.cv-overlay')`, 8000);
  const autoTitle = await js(`(function(){const o=document.querySelector('.cv-overlay');
    return o ? o.innerText.replace(/\\s+/g,' ').slice(0,120) : ''})()`);
  check('版本变化后自动弹本次更新', autoOpen && autoTitle.includes(((meta.changelog || {}).title) || '版本更新'), String(autoTitle).slice(0, 100));
  await sleep(350);
  await shot('10-changelog-popup');
  await js(`document.querySelector('.cv-overlay .btn.primary').click();'ok'`);
  const seen = await js(`localStorage.getItem('cadence_seen_version')`);
  check('看过之后写回当前版本', seen === meta.semver, String(seen));

  await goto(BASE); await sleep(1500);
  check('同一版本不再打扰', !(await js(`!!document.querySelector('.cv-overlay')`)));

  /* ---------- 9 下属身份 ---------- */
  await js(`localStorage.setItem('pm_mvp_me','1002');'ok'`);
  await goto(BASE); await sleep(1500);
  const sub = await js(`(function(){return {name:document.querySelector('#meName').textContent.trim(),
    badge:document.querySelector('#intakeBadge').textContent.trim(),
    hidden:document.querySelector('#intakeBadge').style.display==='none'}})()`);
  /* 角标数字不写死：与库里「待接收且仍待开展」的条数对齐即可，
     免得演示数据一动，测试就假红 */
  const expectBadge = Number(await js(`(async()=>{const j=await (await fetch('/api/state?me=1002')).json();
    return j.tasks.filter(t=>t.type==='assign'&&t.intakeStatus==='pending'&&t.status==='todo').length})()`));
  check('下属身份登录 + 承接角标与待接收数一致',
    sub.name === '李明' && Number(sub.badge) === expectBadge
      && (expectBadge === 0 ? sub.hidden : !sub.hidden),
    JSON.stringify(sub) + ' 期望角标=' + expectBadge);
  await nav('intake'); await shot('03-intake-sub');

  /* ---------- 9.2 上级派活 → 下属规划承接 → 上级仍能追踪（v0.4.0 修复项） ---------- */
  const SRC = 't_e2e_src', CARRIED = 't_e2e_carried';
  const push = (m, b) => js(`(async()=>{
    const r = await fetch('/api/sync', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(Object.assign({ me:'${m}' }, ${JSON.stringify(b)})) });
    return (await r.json()).ok === true;
  })()`);
  await js(`localStorage.setItem('pm_mvp_me','1012');'ok'`);
  await goto(BASE); await sleep(1200);
  await push('1012', { tasks: [{ id: SRC, ownerNo: '1012', assigneeNo: '1002', type: 'assign',
    title: 'E2E派活：季度复盘', start: '2026-11-03', end: '2026-11-06', status: 'todo', intakeStatus: 'pending' }] });
  await push('1002', { tasks: [
    { id: CARRIED, ownerNo: '1002', assigneeNo: '1002', type: 'special', title: 'E2E承接：拆解成两段',
      start: '2026-11-03', end: '2026-11-06', status: 'doing', sourceId: SRC,
      stages: [{ name: '收数', done: true }, { name: '写稿', done: false }] },
    { id: SRC, ownerNo: '1012', assigneeNo: '1002', type: 'assign', title: 'E2E派活：季度复盘',
      start: '2026-11-03', end: '2026-11-06', status: 'todo', intakeStatus: 'accepted' }
  ] });
  await goto(BASE); await sleep(1200);
  await nav('assign'); await sleep(400);

  const carry = await js(`(function(){const el=document.querySelector('.carry');
    return el ? { id: el.dataset.id, txt: el.innerText.replace(/\\s+/g,' ') } : null})()`);
  check('上级在下派任务里看到承接后的进展', !!carry && carry.id === CARRIED && carry.txt.includes('50%'),
    JSON.stringify(carry).slice(0, 160));

  /* 行尾按钮：说的是「查看」，不是含糊的「管理」 */
  const rowBtn = await js(`(function(){const b=[...document.querySelectorAll('#view table button[data-act="open"]')][0];
    return b ? b.innerText.trim() : ''})()`);
  check('下派任务行尾按钮叫「查看」而不是「管理」', rowBtn === '查看', rowBtn);

  await js(`document.querySelector('.carry').click();'ok'`);
  await sleep(600);
  const detailShape = await js(`(function(){return {
    pageTitle: (document.querySelector('#pageTitle')||{}).textContent.trim(),
    drawer: !!document.querySelector('#drawer'),
    kpis: document.querySelectorAll('#view .td-kpis > div').length,
    cols: document.querySelectorAll('#view .grid-2 > div').length,
    back: !!document.querySelector('#view .td-head [data-act="close"]')}})()`);
  check('点开是整页详情（没有抽屉），抬头 4 个指标 + 两栏',
    detailShape.pageTitle === '任务详情' && detailShape.drawer === false
      && detailShape.kpis === 4 && detailShape.cols === 2 && detailShape.back,
    JSON.stringify(detailShape));

  const ro = await js(`(function(){const t=document.querySelector('#dTitle');
    return t ? { readonly: t.readOnly, val: t.value,
      tags: [...document.querySelectorAll('.td-head .split .tag')].map(x=>x.innerText.trim()).join('|'),
      formFields: document.querySelectorAll('#view [data-field]').length,
      kv: document.querySelectorAll('#view .kv').length } : null})()`);
  check('承接任务对上级只读：没有表单控件，改用键值表展示，且标注「承接」而非「下派」',
    !!ro && ro.readonly === true && String(ro.tags).includes('承接') && !String(ro.tags).includes('下派')
      && ro.formFields <= 1 && ro.kv >= 5,
    JSON.stringify(ro).slice(0, 200));
  await shot('11-assign-carry');
  await js(`document.querySelector('.td-head [data-act="close"]').click();'ok'`);
  await sleep(300);

  await push('1012', { del: { tasks: [SRC] } });
  await push('1002', { del: { tasks: [CARRIED, SRC] } });

  /* ---------- 9.3 「待接收」不会挂在已经推进的任务上 ---------- */
  const AUTO = 't_e2e_auto';
  await push('1012', { tasks: [{ id: AUTO, ownerNo: '1012', assigneeNo: '1002', type: 'assign',
    title: 'E2E自动落定', start: '2026-11-03', end: '2026-11-06', status: 'todo', intakeStatus: 'pending' }] });
  // 下属在日历/抽屉里把状态改成进行中，此时前端对象里的 intakeStatus 仍是 pending
  await push('1002', { tasks: [{ id: AUTO, ownerNo: '1012', assigneeNo: '1002', type: 'assign',
    title: 'E2E自动落定', start: '2026-11-03', end: '2026-11-06', status: 'doing', intakeStatus: 'pending' }] });
  const auto = await js(`(async()=>{const j=await (await fetch('/api/state?me=1002')).json();
    const t=j.tasks.find(x=>x.id==='${AUTO}'); return t?{status:t.status,intake:t.intakeStatus}:null})()`);
  check('任务一推进到进行中，就不再挂「待接收」',
    !!auto && auto.status === 'doing' && auto.intake === 'accepted', JSON.stringify(auto));

  const mixed = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    return j.tasks.filter(t=>t.intakeStatus==='pending'&&t.status!=='todo').map(t=>t.title)})()`);
  check('全量数据里没有「进行中 + 待接收」的矛盾组合', mixed.length === 0, JSON.stringify(mixed).slice(0, 120));

  await push('1012', { del: { tasks: [AUTO] } });
  await push('1002', { del: { tasks: [AUTO] } });


  /* ---------- 9.4 专项/临时不能指派给别人：承接人锁自己 ---------- */
  await js(`localStorage.setItem('pm_mvp_me','1012');'ok'`);
  await goto(BASE); await sleep(1200);
  await nav('special'); await sleep(400);
  await js(`document.querySelector('[data-act="new"][data-type="special"]').click();'ok'`);
  await sleep(400);
  const lock1 = await js(`(function(){const w=document.querySelector('#fAssigneeWrap'); if(!w) return null;
    return { hasSelect: !!w.querySelector('select'), locked: (w.querySelector('.locked')||{}).innerText||'' }})()`);
  check('新建专项：承接人锁成「我」，没有下拉可选',
    !!lock1 && lock1.hasSelect === false && lock1.locked.includes('我（本人）'), JSON.stringify(lock1).slice(0, 160));

  await js(`(function(){const s=document.querySelector('#f_type'); s.value='assign'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'})()`);
  await sleep(350);
  const lock2 = await js(`(function(){const s=document.querySelector('#fAssigneeWrap select');
    return { opts: s ? s.options.length : 0 }})()`);
  check('切成下派任务后承接人恢复可选（我 + 下属）', lock2.opts >= 2, JSON.stringify(lock2));

  await js(`(function(){const s=document.querySelector('#f_type'); s.value='special'; s.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'})()`);
  await sleep(350);
  const lock3 = await js(`(function(){const w=document.querySelector('#fAssigneeWrap');
    return { hasSelect: !!w.querySelector('select') }})()`);
  check('切回专项又锁回自己', lock3.hasSelect === false, JSON.stringify(lock3));
  await shot('12-special-locked');

  await js(`(function(){document.querySelector('#f_title').value='E2E专项：只能归自己';
    document.querySelector('#modal [data-act="modal-ok"]').click(); return 'ok'})()`);
  await sleep(1000);
  const made = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.filter(x=>x.type==='special'&&x.title==='E2E专项：只能归自己').pop();
    return t?{id:t.id,type:t.type,owner:t.ownerNo,assignee:t.assigneeNo}:null})()`);
  check('界面建出来的专项，承接人就是自己', !!made && made.assignee === '1012', JSON.stringify(made));

  if (made) {
    await js(`openTaskPage('${made.id}');'ok'`); await sleep(500);
    const dr = await js(`(function(){const s=document.querySelector('#view [data-field="assigneeNo"]');
      const l=document.querySelector('#view .locked');
      return { hasSelect: !!s, locked: (l||{}).innerText||'' }})()`);
    check('专项详情里也没有换人的下拉，只显示本人',
      dr.hasSelect === false && dr.locked.includes('本人'), JSON.stringify(dr).slice(0, 160));
    await shot('13-special-drawer');
    await js(`document.querySelector('.td-head [data-act="close"]').click();'ok'`);
    await sleep(300);
    await push('1012', { del: { tasks: [made.id] } });
  }

  /* 界面之外再兜一层：直接写接口把专项塞给别人，也该落回本人 */
  const GUARD = 't_e2e_guard_special';
  await push('1012', { tasks: [{ id: GUARD, ownerNo: '1012', assigneeNo: '1002', type: 'special',
    title: 'E2E绕过界面塞给别人', start: '2026-11-03', end: '2026-11-06', status: 'todo' }] });
  const guard = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.find(x=>x.id==='${GUARD}'); return t?{assignee:t.assigneeNo}:null})()`);
  check('绕过界面直接写接口，专项也落回本人', !!guard && guard.assignee === '1012', JSON.stringify(guard));
  await push('1012', { del: { tasks: [GUARD] } });

  /* 下派任务换承接人要真正落库（原来抽屉改完刷新就回去） */
  const SWAP = 't_e2e_swap';
  await push('1012', { tasks: [{ id: SWAP, ownerNo: '1012', assigneeNo: '1002', type: 'assign',
    title: 'E2E换承接人', start: '2026-11-03', end: '2026-11-06', status: 'todo', intakeStatus: 'pending' }] });
  await push('1012', { tasks: [{ id: SWAP, ownerNo: '1012', assigneeNo: '1003', type: 'assign',
    title: 'E2E换承接人', start: '2026-11-03', end: '2026-11-06', status: 'todo', intakeStatus: 'pending' }] });
  const swap = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.find(x=>x.id==='${SWAP}'); return t?{assignee:t.assigneeNo,intake:t.intakeStatus}:null})()`);
  check('下派任务换承接人真正落库，并重新变成待接收',
    !!swap && swap.assignee === '1003' && swap.intake === 'pending', JSON.stringify(swap));
  await push('1012', { del: { tasks: [SWAP] } });
  await push('1003', { del: { tasks: [SWAP] } });

  /* ---------- 9.45 下派自由选人 + 专项知情人 + 下派页四模块 ---------- */
  await js(`localStorage.setItem('pm_mvp_me','1012');'ok'`);
  await goto(BASE); await sleep(1200);
  await nav('assign'); await sleep(500);

  /* 四个模块、顺序固定 */
  const blocks = await js(`[...document.querySelectorAll('#view .card-h h2')].map(h=>h.textContent.trim())`);
  check('下派任务页按「我下派的任务 → 下属常规 → 下属专项 → 我关注的任务」四块排',
    JSON.stringify(blocks) === JSON.stringify(['我下派的任务', '下属常规工作推进情况', '下属专项工作推进情况', '我关注的任务']),
    JSON.stringify(blocks));

  /* 下属专项默认折叠：收着的时候一条专项都不渲染，点标题才展开 */
  const spFold = await js(`(function(){
    const cards=[...document.querySelectorAll('#view .card')];
    const card=cards.find(c=>c.textContent.includes('下属专项工作推进情况'));
    if(!card) return null;
    const head=card.querySelector('.card-h');
    return {open:openSpecialBlock, rows:card.querySelectorAll('.rline').length,
      hint:head.innerText.replace(/\\s+/g,' '), clickable:head.classList.contains('fold')};})()`);
  check('下属专项工作推进情况默认收起，一条不显示，标题可点',
    !!spFold && spFold.open === false && spFold.rows === 0 && spFold.clickable === true
      && spFold.hint.includes('默认收起'),
    JSON.stringify(spFold).slice(0, 180));

  await js(`document.querySelector('#view .card-h.fold').click();'ok'`);
  await sleep(500);
  const spOpen = await js(`(function(){
    const cards=[...document.querySelectorAll('#view .card')];
    const card=cards.find(c=>c.textContent.includes('下属专项工作推进情况'));
    return {open:openSpecialBlock, rows:card.querySelectorAll('.rline').length,
      watchable:card.querySelectorAll('[data-act="watch-task"]').length,
      txt:card.innerText.replace(/\\s+/g,' ').slice(0,140)};})()`);
  check('点开后按下属列出各自的专项，每条都能「关注」',
    spOpen.open === true && spOpen.rows >= 1 && spOpen.watchable >= 1, JSON.stringify(spOpen).slice(0, 200));

  /* 关注一条下属专项 → 出现在「我关注的任务」 */
  const watchedTitle = await js(`(function(){
    const card=[...document.querySelectorAll('#view .card')].find(c=>c.textContent.includes('下属专项工作推进情况'));
    const row=card.querySelector('.rline');
    const title=row.querySelector('.rnm').textContent.trim();
    row.querySelector('[data-act="watch-task"]').click();
    return title;})()`);
  await sleep(800);
  const inFollow = await js(`(function(){
    const card=[...document.querySelectorAll('#view .card')].find(c=>c.textContent.includes('我关注的任务'));
    const rows=[...card.querySelectorAll('.follow-row')].map(r=>r.innerText.replace(/\\s+/g,' '));
    return {hit:rows.some(t=>t.includes(${JSON.stringify(watchedTitle)})), n:rows.length};})()`);
  check('关注一条下属专项后，它出现在「我关注的任务」里',
    inFollow.hit === true, `关注=${watchedTitle} 列表=${inFollow.n}`);

  /* 承接人：全公司可选，非下属与「没登录过」都标出来 */
  await js(`document.querySelector('[data-act="new"][data-type="assign"]').click();'ok'`);
  await sleep(450);
  const dd = await js(`(function(){
    const s=document.querySelector('#f_assignee'); if(!s) return null;
    const opts=[...s.options].map(o=>({v:o.value,t:o.textContent.trim()}));
    return {n:opts.length, groups:[...s.querySelectorAll('optgroup')].map(g=>g.label),
      nonSub:opts.filter(o=>o.t.includes('非下属')).map(o=>o.v),
      never:opts.filter(o=>o.t.includes('未登录过')).map(o=>o.v),
      has1001:opts.some(o=>o.v==='1001')};})()`);
  check('承接人下拉是全公司花名册，非下属照常可选并标「非下属」',
    !!dd && dd.n >= 7 && dd.has1001 === true && dd.nonSub.includes('1001')
      && JSON.stringify(dd.groups) === JSON.stringify(['我的下属', '其他同事']),
    JSON.stringify(dd).slice(0, 220));
  check('从没登录过工作台的人在下拉里标「未登录过」',
    !!dd && dd.never.includes('1101') && dd.never.includes('1102'), JSON.stringify(dd && dd.never));

  /* 派给没登录过的人：前端当场拦住，弹窗不关，一个字都不告诉「已派出」 */
  const blockedUi = await js(`(function(){
    document.querySelector('#f_title').value='E2E派给没登录过的人';
    const s=document.querySelector('#f_assignee'); s.value='1102';
    document.querySelector('#modal [data-act="modal-ok"]').click();
    return {stillOpen:document.querySelector('#modalWrap').classList.contains('show')};})()`);
  await sleep(700);
  const blockedToast = (await txt('#toast')).trim();
  const blockedDb = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    return j.tasks.some(t=>t.title==='E2E派给没登录过的人')})()`);
  check('派给没登录过的人被拦下：弹窗不关、说明原因、任务没建出来',
    blockedUi.stillOpen === true && blockedToast.includes('还没有登录过工作台') && blockedDb === false,
    JSON.stringify({ open: blockedUi.stillOpen, toast: blockedToast.slice(0, 60), created: blockedDb }));

  await js(`document.querySelector('#modal [data-act="modal-cancel"]').click();'ok'`);
  await sleep(300);

  /* 服务端也拦一层：绕过界面直接写接口，同样进不去 */
  const srvBlock = await js(`(async()=>{
    const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({me:'1012',tasks:[{id:'t_e2e_block',type:'assign',title:'E2E服务端该拦',
        ownerNo:'1012',assigneeNo:'1102',start:'2026-11-03',end:'2026-11-06',status:'todo',stages:[]}]})});
    const j=await r.json();
    const st=await (await fetch('/api/state?me=1012')).json();
    return {errors:j.errors||[], exists:st.tasks.some(t=>t.id==='t_e2e_block')};})()`);
  check('绕过界面直接调接口，派给没登录过的人也进不去，并带回原因',
    srvBlock.errors.length >= 1 && srvBlock.errors[0].includes('还没有登录过工作台') && srvBlock.exists === false,
    JSON.stringify(srvBlock).slice(0, 200));

  /* 不再要求下派人自己有直属上级：页面上不该再挂「先设直属上级」那条拦截 */
  const mgrBlock = await js(`(function(){
    const v=document.querySelector('#view');
    return {bar:!!v.querySelector('.noauth-bar'), blocked:/先设置直属上级|暂不可用/.test(v.innerText)};})()`);
  check('下派页不再挂「先设直属上级才能下派」的拦截',
    mgrBlock.bar === false && mgrBlock.blocked === false, JSON.stringify(mgrBlock));

  /* 专项知情人：可选没登录过的人（知情不依赖对方账号） */
  await nav('special'); await sleep(400);
  await js(`document.querySelector('[data-act="new"][data-type="special"]').click();'ok'`);
  await sleep(450);
  const obsPick = await js(`(function(){
    const w=document.querySelector('#fObsWrap');
    if(!w) return null;
    const rows=[...document.querySelectorAll('#f_obs_list .obs-row')];
    const target=rows.find(r=>r.querySelector('input').dataset.no==='1101');
    if(!target) return {rows:rows.length, found:false};
    const marked=target.innerText.includes('未登录过');
    target.querySelector('input').click();
    return {rows:rows.length, found:true, marked,
      picked:document.querySelector('#f_obs_picked').textContent.trim()};})()`);
  check('新建专项有「知情人」多选区，没登录过的人也在名单里、能选中',
    !!obsPick && obsPick.found === true && obsPick.marked === true && obsPick.picked.includes('1 人'),
    JSON.stringify(obsPick).slice(0, 200));

  const OBS_TASK = 'E2E专项：带知情人';
  await js(`(function(){
    document.querySelector('#f_title').value=${JSON.stringify(OBS_TASK)};
    document.querySelector('#modal [data-act="modal-ok"]').click(); return 'ok'})()`);
  await sleep(1200);
  const obsSaved = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.filter(x=>x.title===${JSON.stringify(OBS_TASK)}).pop();
    return t?{id:t.id,observers:t.observers}:null})()`);
  check('知情人选没登录过的人也不阻断，专项照常建成并记下名单',
    !!obsSaved && obsSaved.observers.includes('1101'), JSON.stringify(obsSaved).slice(0, 160));

  /* 知情人视角：能在「我关注的任务」里看到这条，且只有查看权 */
  if (obsSaved) {
    await js(`localStorage.setItem('pm_mvp_me','1101');'ok'`);
    await goto(BASE); await sleep(1500);
    if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
      await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(1000);
    }
    await nav('assign'); await sleep(600);
    const obsView = await js(`(function(){
      const card=[...document.querySelectorAll('#view .card')].find(c=>c.textContent.includes('我关注的任务'));
      const rows=[...card.querySelectorAll('.follow-row')].map(r=>({
        txt:r.innerText.replace(/\\s+/g,' '), tag:(r.querySelector('.tag')||{}).textContent||''}));
      return {rows, hit:rows.find(r=>r.txt.includes(${JSON.stringify(OBS_TASK)}))};})()`);
    check('别人让你知情的专项出现在「我关注的任务」，标「知情」并写明是谁让你知情',
      !!obsView.hit && obsView.hit.tag.trim() === '知情' && obsView.hit.txt.includes('让你知情'),
      JSON.stringify(obsView.hit || {}).slice(0, 180));

    await js(`openTaskPage('${obsSaved.id}');'ok'`); await sleep(500);
    const obsRo = await js(`(function(){
      const t=document.querySelector('#dTitle');
      return {readonly:t?t.readOnly:null, fields:document.querySelectorAll('#view [data-field]').length,
        obsDel:document.querySelectorAll('#view [data-act="obs-del"]').length,
        obsAdd:!!document.querySelector('#view [data-act="obs-add"]')};})()`);
    check('知情人打开这条专项是只读：改不了、也删不掉知情人',
      obsRo.readonly === true && obsRo.obsDel === 0 && obsRo.obsAdd === false,
      JSON.stringify(obsRo));
    await js(`document.querySelector('.td-head [data-act="close"]').click();'ok'`);
    await sleep(300);
    await push('1012', { del: { tasks: [obsSaved.id] } });
  }

  await js(`localStorage.setItem('pm_mvp_me','1012');'ok'`);
  await goto(BASE); await sleep(1200);
  await nav('special'); await sleep(500);

  /* ---------- 9.5 三级节点：阶段下可再拆一级子任务 ---------- */
  await js(`document.querySelector('[data-act="new"][data-type="special"]').click();'ok'`);
  await sleep(400);
  await js(`(function(){
    document.querySelector('#f_title').value='E2E三级：阶段带子任务';
    const r=document.querySelector('#stageRows .mrow');
    r.querySelector('.sname').value='阶段一';
    r.querySelector('[data-act="mstage-sub"]').click();
    return 'ok';
  })()`);
  await sleep(250);
  const subForm = await js(`(function(){
    const k=document.querySelector('#stageRows .mrow.sub');
    if(!k) return {n:0};
    k.querySelector('.sname').value='子任务A';
    return {n:document.querySelectorAll('#stageRows .mrow').length,
      subHasAdd: !!k.querySelector('[data-act="mstage-sub"]')};})()`);
  check('阶段行可以加子任务，子行不再有「+子」（三级封顶）',
    subForm.n === 2 && subForm.subHasAdd === false, JSON.stringify(subForm));
  await shot('18-stage-modal');

  await js(`document.querySelector('#modal [data-act="modal-ok"]').click();'ok'`);
  await sleep(1200);
  const tree = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.filter(x=>x.title==='E2E三级：阶段带子任务').pop();
    if(!t) return null;
    const p=t.stages.filter(s=>!s.pid), k=t.stages.filter(s=>s.pid);
    return {id:t.id,tops:p.length,subs:k.length,pidOk:p.length&&k.length?k[0].pid===p[0].id:false};})()`);
  check('专项能拆到「阶段 → 子任务」，父子挂对并落库',
    !!tree && tree.tops === 1 && tree.subs === 1 && tree.pidOk === true, JSON.stringify(tree));

  if (tree) {
    await js(`openTaskPage('${tree.id}');'ok'`); await sleep(500);
    const treeUi = await js(`(function(){
      return {tops:document.querySelectorAll('#view .stage:not(.sub)').length,
        subs:document.querySelectorAll('#view .stage.sub').length,
        subHasAdd:!!document.querySelector('#view .stage.sub [data-act="stage-sub"]'),
        parentTick:!!document.querySelector('#view .stage:not(.sub) .n[data-act="stage-toggle"]')};})()`);
    check('详情页按层级渲染：一级带序号、子任务缩进，父阶段不单独给勾选框',
      treeUi.tops === 1 && treeUi.subs === 1 && treeUi.subHasAdd === false && treeUi.parentTick === false,
      JSON.stringify(treeUi));
    await shot('17-stage-tree');

    await js(`document.querySelector('.td-head [data-act="close"]').click();'ok'`); await sleep(300);
    await nav('calendar'); await sleep(700);
    const cal = await js(`(function(){const names=[...document.querySelectorAll('.chip.cal')].map(x=>x.innerText);
      return {sub:names.filter(t=>t.includes('子任务A')).length, parent:names.filter(t=>t.includes('阶段一')).length};})()`);
    check('日历上出的是子任务名，父阶段不再单独出一条',
      cal.sub >= 1 && cal.parent === 0, JSON.stringify(cal));

    await js(`moveTask('${tree.id}','2026-11-10',0);'ok'`);
    await sleep(900);
    const moved = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
      const t=j.tasks.find(x=>x.id==='${tree.id}');
      const p=t.stages.find(s=>!s.pid), k=t.stages.find(s=>s.pid);
      return {ps:p.start,ks:k.start,st:t.status};})()`);
    check('拖有子任务的阶段，子任务跟着平移同样的天数',
      moved.ps === '2026-11-10' && moved.ks === '2026-11-10', JSON.stringify(moved));

    /* 勾选放在拖动之后：勾完唯一子任务任务就完成了，已完成的任务拖不动 */
    await js(`openTaskPage('${tree.id}');'ok'`); await sleep(500);
    await js(`document.querySelector('#view .stage.sub .n[data-act="stage-toggle"]').click();'ok'`);
    await sleep(900);
    const prog = await js(`(function(){const b=document.querySelectorAll('#view .td-kpis b');
      return {prog:b[0]?b[0].innerText:'',cnt:b[1]?b[1].innerText:''}})()`);
    check('勾完唯一的子任务 → 进度 100%，父阶段不重复计数',
      prog.prog === '100%' && prog.cnt === '1 / 1', JSON.stringify(prog));

    await push('1012', { del: { tasks: [tree.id] } });
  }

  const tempForm = await js(`(function(){openNewTask('temp');
    const has=!!document.querySelector('#stageRows');
    document.querySelector('#modal [data-act="modal-cancel"]').click();
    return {has:has};})()`);
  await sleep(200);
  check('临时任务新建时没有阶段/子任务入口', tempForm.has === false, JSON.stringify(tempForm));

  /* 子任务越界：它一挪，父阶段的边界跟着长，不能因此压到下一段 */
  const GRD = 't_e2e_drag_root';
  await push('1012', { tasks: [{ id: GRD, ownerNo: '1012', assigneeNo: '1012', type: 'special',
    title: 'E2E拖子任务越界', start: '2026-11-03', end: '2026-11-20', status: 'todo',
    stages: [
      { id: 'g1', pid: null, name: '第一段', start: '2026-11-03', end: '2026-11-10', done: false },
      { id: 'g2', pid: 'g1', name: '子一', start: '2026-11-03', end: '2026-11-05', done: false },
      { id: 'g3', pid: 'g1', name: '子二', start: '2026-11-06', end: '2026-11-10', done: false },
      { id: 'g4', pid: null, name: '第二段', start: '2026-11-11', end: '2026-11-20', done: false },
    ] }] });
  await js(`refresh(true);'ok'`); await sleep(900);
  const verdict = await js(`(function(){
    const t=S.tasks.find(x=>x.id==='${GRD}');
    if(!t) return null;
    const i=t.stages.findIndex(s=>s.id==='g3');
    const r=dragCheck(t,'2026-11-13',i);
    return {ok:r.ok, why:r.why||''};})()`);
  check('子任务越界拖动会带着父阶段压到下一段，被拦下并说清原因',
    !!verdict && verdict.ok === false && verdict.why.includes('下一阶段'), JSON.stringify(verdict));
  await push('1012', { del: { tasks: [GRD] } });

  /* ---------- 10 点遮罩/按 Esc 不能烧掉没保存的内容 ---------- */
  const modalGuard = await js(`(function(){
    const w=document.querySelector('#modalWrap'), m=document.querySelector('#modal');
    openNewTask('temp');
    w.click();
    const closedEmpty = !w.classList.contains('show');
    openNewTask('temp');
    const input=document.querySelector('#f_title');
    input.value='不该丢的任务名';
    w.click();
    const stillOpen = w.classList.contains('show');
    const note = (document.querySelector('#modalNote')||{}).textContent||'';
    const kept = input.value;
    const shook = m.classList.contains('shake');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    const afterEsc = w.classList.contains('show') && document.querySelector('#f_title').value==='不该丢的任务名';
    return {closedEmpty:closedEmpty, stillOpen:stillOpen, note:note, kept:kept, shook:shook, afterEsc:afterEsc};
  })()`);
  await sleep(500);
  await shot('16-modal-guard');
  check('空表单点遮罩照旧关闭（不添麻烦）', modalGuard.closedEmpty === true, JSON.stringify(guard));
  check('填过内容点遮罩不关：内容还在，并说明原因',
    modalGuard.stillOpen === true && modalGuard.kept === '不该丢的任务名' && modalGuard.note.includes('还没保存') && modalGuard.shook === true,
    JSON.stringify({ open: modalGuard.stillOpen, kept: modalGuard.kept, note: modalGuard.note, shake: modalGuard.shook }));
  check('填过内容按 Esc 也不关', modalGuard.afterEsc === true, JSON.stringify({ afterEsc: modalGuard.afterEsc }));

  const saved = await js(`(function(){
    document.querySelector('[data-act=modal-ok]').click(); return 'ok';
  })()`);
  await sleep(1600);
  const savedDb = await js(`(async()=>{const r=await fetch('/api/state?me=1012');const s=await r.json();
    const t=s.tasks.find(x=>x.title==='不该丢的任务名');
    return t?{title:t.title,start:t.start}:null})()`);
  check('被拦下之后再点保存能正常落库', saved === 'ok' && !!savedDb, JSON.stringify(savedDb));

  /* ---------- 9.5 花名册两条通道：表里填 / 本人自选，落同一个字段 ---------- */
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const runImport = (...a) => {
    try {
      return execFileSync(process.execPath, ['--no-warnings', 'import-emp.js', ...a], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      return String(e.stdout || '') + String(e.stderr || '');
    }
  };
  const writeCsv = (name, body) => {
    const rel = `_dev/${name}`;
    fs.writeFileSync(`${ROOT}${rel}`, '\uFEFF' + body, 'utf8');
    return rel;
  };
  // 重置成「没有上级」
  runImport(writeCsv('t-reset.csv', '工号,姓名,岗位,部门,上级工号\n1019,钱多,测试员,产品部,-\n'));

  await js(`localStorage.setItem('pm_mvp_me','1019');'ok'`);
  await goto(BASE);
  const askMgr = await waitFor(
    `document.querySelector('#auth.show') && /选择你的直属上级/.test(document.querySelector('#authBody').innerText)`, 8000);
  check('没有上级的人登录后自动要求选上级', askMgr,
    (await js(`(document.querySelector('#authBody')||{}).innerText||''`)).replace(/\s+/g, ' ').slice(0, 80));

  await js(`(function(){const i=document.querySelector('#a_kw');i.value='1012';
    i.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()`);
  await sleep(300);
  const picked = await js(`(function(){const it=document.querySelector('.mgr-item[data-no="1012"]');
    if(!it) return 'no-item'; it.click(); return 'ok'})()`);
  await js(`document.querySelector('[data-act=confirm-mgr]').click();'ok'`);
  await sleep(1500);
  const mgrNow = () => js(`(async()=>{const r=await fetch('/api/state?me=1019');const s=await r.json();
    return s.me && s.me.mgr ? s.me.mgr.no : null})()`);
  const afterPick = await mgrNow();
  check('本人选的上级落进花名册（mgr_no）', picked === 'ok' && afterPick === '1012', `${picked} / mgr=${afterPick}`);

  // 上级列留空再导一次：不能把自选的结果冲掉
  const outBlank = runImport(writeCsv('t-blank.csv', '工号,姓名,岗位,部门,上级工号\n1019,钱多,测试员,产品部,\n'));
  const afterBlank = await mgrNow();
  check('重新导入（上级留空）不会冲掉本人自选的上级',
    afterBlank === '1012' && outBlank.includes('保留了他们自己选的上级'),
    `mgr=${afterBlank} / ${outBlank.trim().split('\n')[1] || ''}`);

  // 表里明确写了上级：以表为准
  const outSet = runImport(writeCsv('t-set.csv', '工号,姓名,岗位,部门,上级工号\n1019,钱多,测试员,产品部,1001\n'));
  const afterSet = await mgrNow();
  check('表里明确填了上级则以表为准', afterSet === '1001' && outSet.includes('本次按表写入'), `mgr=${afterSet}`);

  // 上级工号写错：整批不写
  const outBad = runImport(writeCsv('t-bad.csv', '工号,姓名,岗位,部门,上级工号\n1020,孙丽,专员,产品部,9999\n'));
  const login1020 = await js(`(async()=>{const r=await fetch('/api/login',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({no:'1020',name:'孙丽'})});
    return (await r.json()).ok})()`);
  check('上级工号不存在时整批不写（1020 没进库）',
    outBad.includes('不在花名册里') && login1020 === false,
    outBad.trim().split('\n')[2] || '');

  // 测试账号用完直接删掉，别留在花名册里
  execFileSync(process.execPath, ['--no-warnings', '-e',
    `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/workbench.db');
     db.prepare('DELETE FROM emp WHERE no=?').run('1019');
     db.prepare('UPDATE meta SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k=?').run('rev');`],
    { cwd: ROOT });

  /* ---------- 11 错误汇总 ---------- */
  const errs = cdp.events.filter((e) =>
    e.method === 'Runtime.exceptionThrown' ||
    (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'));
  const netFail = cdp.events.filter((e) => e.method === 'Network.loadingFailed' && !e.params?.canceled);
  check('无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).map((e) => JSON.stringify(e.params).slice(0, 220)).join(' | '));
  check('无失败请求', netFail.length === 0, netFail.slice(0, 3).map((e) => JSON.stringify(e.params).slice(0, 160)).join(' | '));

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== 合计 ${results.length} 项，失败 ${bad.length} 项 =====`);
  if (bad.length) bad.forEach((b) => console.log('  失败：' + b.name + ' · ' + b.info));
  ws.close(); killTree(child.pid);
  setTimeout(() => process.exit(bad.length ? 1 : 0), 300);
}

main().catch((e) => {
  console.error('自检异常: ' + e.message);
  /* 异常退出也要收干净：留着会把下一轮的 9333 占住，故障表现出来就是「随机断言失败」 */
  if (child) killTree(child.pid);
  process.exit(2);
});
