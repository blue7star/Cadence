/* 端到端自检：直接用 CDP 驱动本机 Chromium，无第三方依赖。
   用法：node _dev/e2e.mjs [baseUrl]
   产出：_dev/shots/*.png + 控制台报告（有失败项退出码 1）
   覆盖：登录、七个页面、日历当月、下属看板、勾选持久化、拖拽改期、
        清空后的空态可用性、新建规则、快速建临时任务、载入示例数据、
        切换下属身份看承接台、JS 错误与请求失败。 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Users/lanmingjian/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
/* 每次随机挑一个调试端口：固定端口在上一轮崩溃、浏览器没退干净时会撞车。
   撞车后的表现极具误导性——新浏览器起不来，脚本连到的其实是上一轮那个卡住的页面，
   于是到处「CDP timeout」，看起来像应用坏了。 */
const PORT = 9300 + Math.floor(Math.random() * 200);
const BASE = process.argv[2] || 'http://localhost:8788';
/* e2e 的固定基线会直接改库：把全员密码重置成工号、删测试工号、造夹具任务。
   这些一旦落在真实库上，「跑一次自检」就等于改一次业务数据，而且没有任何提示。
   所以库路径必须由调用方显式给出，且不允许指向真实库：
   平时只通过 `node _dev/verify.mjs --full` 跑——它先 VACUUM 一份副本到 _dev/.test-db/。 */
const REAL_DB = path.resolve(fileURLToPath(new URL('../data/workbench.db', import.meta.url)));
const DB = process.env.CADENCE_DB ? path.resolve(process.env.CADENCE_DB) : '';
if (!DB || DB === REAL_DB) {
  console.error('拒绝在真实库上跑 e2e：它会重置全员密码、删测试工号、造夹具任务。\n'
    + '请用 `node _dev/verify.mjs --full`（自带 _dev/.test-db 副本并传入 CADENCE_DB）。');
  process.exit(2);
}
const SHOTS = fileURLToPath(new URL('./shots/', import.meta.url));
/* 直查数据库做对账：导出/接收这类断言如果回头再看 /api/state，等于让被测接口自己作证。 */
const require_ = createRequire(import.meta.url);
const dbGet = (sql, ...p) => {
  const db = new (require_('node:sqlite').DatabaseSync)(DB);
  try { return db.prepare(sql).get(...p); } finally { db.close(); }
};
const dbAll = (sql, ...p) => {
  const db = new (require_('node:sqlite').DatabaseSync)(DB);
  try { return db.prepare(sql).all(...p); } finally { db.close(); }
};
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

  /* ---- 会话助手（第一批认证上线后必需） ----
     Node 自带 fetch 不保存 cookie，而且浏览器里 JS 读不到 HttpOnly 的 sid。
     所以：① Node 侧按身份登录一次拿 sid；② 需要换身份时用 CDP 直接写浏览器 cookie。 */
  const SIDS = new Map();
  const loginSid = async (no, pwd) => {
    const r = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ no, password: pwd === undefined ? no : pwd })
    });
    const d = await r.json().catch(() => ({}));
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(list.join('; '));
    return { ok: !!d.ok, msg: d.msg || '', locked: !!d.locked, status: r.status, sid: m ? m[1] : '', me: d.me || null, admin: !!d.admin, mustChange: !!d.mustChange };
  };
  const sidOf = async (no) => {
    if (!SIDS.has(no)) {
      const r = await loginSid(no);
      if (!r.ok) throw new Error(`登录 ${no} 失败：${r.msg}`);
      SIDS.set(no, r.sid);
    }
    return SIDS.get(no);
  };
  /* Node 侧直调接口：带指定身份的 cookie，不依赖浏览器当前登录的是谁 */
  const apiAs = async (no, path, body, method) => {
    const sid = await sidOf(no);
    const r = await fetch(BASE + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: Object.assign({ Cookie: 'sid=' + sid }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await r.json(); } catch { /* 非 JSON（导出 CSV 等） */ }
    return { status: r.status, json };
  };
  const stateAs = async (no) => (await apiAs(no, '/api/state')).json;
  /* 把浏览器切到某个身份：写 cookie + 刷新（身份不再靠 localStorage） */
  const asUser = async (no) => {
    const sid = await sidOf(no);
    /* setCookie 属于 Network 域，先 enable 一次（重复调用无害） */
    try { await S('Network.enable'); } catch { }
    await S('Network.setCookie', { name: 'sid', value: sid, url: BASE, path: '/', httpOnly: true });
    await goto(BASE);
    await sleep(1200);
  };
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
  /* ---------- 0 固定基线 ---------- */
  await goto(BASE);
  /* 失败锁定用例需要「真实账号 + 一定会被锁」。
     用一个每轮新开工号，锁就锁它，不会把演示账号锁给下一轮。 */
  const LOCKNO = '9' + String(Date.now()).slice(-6);
  /* 先把所有人的密码复位成「初始密码 = 工号」。
     上一轮跑过改密/超管重置用例，库里 1012 的密码就不是工号了；
     不复位的话这一轮第一步登录就红，看起来像功能坏了，其实是夹具没归零。 */
  {
    const ROOT0 = fileURLToPath(new URL('..', import.meta.url));
    execFileSync(process.execPath, ['--no-warnings', '-e', `
      const {DatabaseSync}=require('node:sqlite');
      const crypto=require('node:crypto');
      const db=new DatabaseSync(${JSON.stringify(DB)});
      for (const e of db.prepare('SELECT no FROM emp').all()) {
        const salt=crypto.randomBytes(16).toString('hex');
        const hash=crypto.scryptSync(e.no,salt,64,{N:16384,r:8,p:1}).toString('hex');
        db.prepare(\`INSERT INTO cred(no,hash,salt,initial,changed_at) VALUES(?,?,?,1,?)
          ON CONFLICT(no) DO UPDATE SET hash=excluded.hash,salt=excluded.salt,initial=1,changed_at=excluded.changed_at\`)
          .run(e.no,hash,salt,new Date().toISOString());
      }
      db.prepare("DELETE FROM emp WHERE no GLOB '9[0-9][0-9][0-9][0-9][0-9][0-9]'").run();
      db.prepare("INSERT INTO emp(no,name,role,dept,mgr_no,active,activated) VALUES(?,?,?,?,NULL,1,0)")
        .run('${LOCKNO}','锁定用例','测试','产品部');
      db.close();`], { cwd: ROOT0, stdio: 'ignore' });
  }
  await js(`localStorage.clear(); sessionStorage.clear(); 'ok'`);
  await goto(BASE);
  check('登录页出现', await js(`!!document.querySelector('#auth.show')`));
  check('登录页不展示任何工号名单',
    !/1012|1002|张启明|李明/.test(await txt('#authBody')));
  await js(`(function(){document.querySelector('#a_no').value='1012';
    document.querySelector('#a_pwd').value='1012';
    document.querySelector('[data-act=do-login]').click();return 'ok'})()`);
  await sleep(1600);
  /* 先拿到 1012 的会话，下面的固定基线（清空 + 载入示例数据）走 Node 侧带 cookie 调用 */
  await apiAs('1012', '/api/reset', { me: '1012' });
  await apiAs('1012', '/api/demo', { me: '1012' });
  /* 「谁登录过」是跨运行保留的：一旦跑过一次，1101 就永久变成「登录过」，
     下一轮「派给没登录过的人」就会假绿。所以基线里把激活状态也钉死：
     产品部这一组（1001 部门经理 + 1012 本人 + 四个下属）算用过；
     人力资源部 / 运营中心那两位总监没参与演示，算没用过——正好当阻断用例的对象。 */
  {
    const ROOT0 = fileURLToPath(new URL('..', import.meta.url));
    execFileSync(process.execPath, ['--no-warnings', '-e', `
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(${JSON.stringify(DB)});
      db.prepare("UPDATE emp SET activated = CASE WHEN no IN ('1001','1002','1003','1004','1005','1012') THEN 1 ELSE 0 END").run();
      db.prepare("UPDATE emp SET last_login=NULL WHERE activated=0").run();
      /* 以前拿别人身份载入过示例数据，会在下属名下留一批 <工号>_t<N>；
         它们在「下属专项工作推进情况」里看起来像是下属自己立的，其实是重复的演示记录。
         这里是测试库，清掉；真实数据不会用这种 id 形态。 */
      db.prepare("DELETE FROM task WHERE owner_no<>'1012' AND id GLOB '[0-9][0-9][0-9][0-9]_t[0-9]*'").run();
      db.prepare("UPDATE meta SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k='rev'").run();
      db.close();`], { cwd: ROOT0, stdio: 'ignore' });
  }
  await asUser('1012');
  if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
    await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(1200);
  }
  const meName = (await txt('#meName')).trim();
  check('工号+密码登录', meName === '王磊', '当前=' + meName);

  /* ---------- 2 七个页面 ---------- */
  for (const v of ['today', 'assign', 'routine', 'special', 'intake', 'calendar', 'settings']) {
    const title = await nav(v);
    const info = await js(`(function(){const el=document.querySelector('#view');return {
      len:(el.innerText||'').trim().length, rows:el.querySelectorAll('tr').length,
      cards:el.querySelectorAll('.card,.rule-card').length}})()`);
    check('页面可打开：' + v, info.len > 50, `${title} / ${info.len}字 / ${info.rows}行 / ${info.cards}卡片`);
    if (['today', 'assign', 'routine', 'calendar', 'settings'].includes(v)) await shot('01-' + v);
  }

  /* ---------- 2.1 专项卡片按层级排，不把子任务平铺成同级阶段 ---------- */
  await nav('special');
  const cardTree = await js(`(function(){
    const arr0=t=>t.stages||[];
    const t=(S.tasks||[]).find(x=>x.type==='special'&&x.ownerNo===S.me.no
      &&arr0(x).some(s=>s.pid)&&arr0(x).every(s=>s.start));
    if(!t) return {err:'没有带子任务的专项'};
    const arr=arr0(t), isTop=s=>!s.pid||!arr.some(x=>x.id===s.pid);
    const exp=[]; let n=0;
    for(const s of arr){ if(!isTop(s)) continue; n++; exp.push({label:String(n),name:s.name,sub:false});
      let k=0;
      for(const c of arr){ if(c.pid!==s.id||isTop(c)) continue; k++;
        exp.push({label:n+'.'+k,name:c.name,sub:true}); } }
    const card=[...document.querySelectorAll('#view .rule-card')]
      .find(c=>{const h=c.querySelector('h2');return h&&h.textContent.trim()===t.title});
    if(!card) return {err:'卡片没渲染出来'};
    const rows=[...card.querySelectorAll('.stage')].map(r=>({
      no:((r.querySelector('.n')||{}).textContent||'').trim(),
      name:((r.querySelector('.sn')||{}).textContent||'').trim(),
      sub:r.classList.contains('sub')}));
    const meta=[...card.querySelectorAll('.mini')].map(x=>x.textContent).find(x=>x.includes('个阶段'))||'';
    return {title:t.title, rows, exp, meta,
      tops:arr.filter(isTop).length, kids:arr.length-arr.filter(isTop).length};
  })()`);
  check('专项卡片按层级编号：一级阶段后面紧跟自己的子任务，不再把子任务平铺成 4、5、6',
    !cardTree.err && cardTree.rows.length === cardTree.exp.length &&
    cardTree.rows.every((r, i) => r.name === cardTree.exp[i].name && r.sub === cardTree.exp[i].sub) &&
    cardTree.rows.every((r, i) => r.no === '✓' || r.no === cardTree.exp[i].label),
    JSON.stringify(cardTree).slice(0, 400));
  check('卡片上的阶段数只数一级阶段，子任务单列',
    !cardTree.err && cardTree.meta.includes(cardTree.tops + ' 个阶段') &&
    (!cardTree.kids || cardTree.meta.includes(cardTree.kids + ' 个子任务')),
    cardTree.meta);
  await shot('02-special-card');

  /* 导航分组定死：自己的事归「我的工作」，跟组员往来的两件归「协作」 */
  const navShape = await js(`(function(){const out=[];document.querySelectorAll('#nav > div').forEach(d=>{
    out.push(d.classList.contains('nav-group') ? '#'+d.textContent.trim() : d.dataset.view)});return out})()`);
  check('导航按「我的工作 / 协作 / 配置」分组，日历待办归自己、发布与承接归协作',
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
      dbDone = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
    /* 正文和角标分开取：正文写的是「哪一段」，角标写的是「哪件事」 */
    return {id:hit.t.id, parent:hit.t.title, stage:hit.st.name,
      chips:[...cell.querySelectorAll('.chip.cal')].map(e=>((e.querySelector('.lbl')||e).textContent)),
      pars:[...cell.querySelectorAll('.chip.cal .par')].map(e=>e.textContent.replace(/^↳\\s*/,''))};
  })()`);
  await sleep(600);
  const dayRows = await js(`(function(){return [...document.querySelectorAll('#view .tlist .trow')]
    .map(r=>({txt:r.innerText.replace(/\\s+/g,' ').trim(), parent:(r.querySelector('.tag.parent')||{}).textContent||''}))})()`);
  check('日历格子显示阶段名（子任务），不再用父任务名占位',
    !stageCal.err && stageCal.chips.some(x => x.includes(stageCal.stage)) &&
    !stageCal.chips.some(x => x.includes(stageCal.parent)),
    JSON.stringify({ stage: stageCal.stage, chips: stageCal.chips, parent: stageCal.parent }));
  /* 「这段是哪件事里的」不能靠猜：正文放阶段名，大任务名退到下面的小角标里 */
  check('阶段条目的下方挂小角标，写明所属大任务',
    !stageCal.err && stageCal.pars.length >= 1 && stageCal.pars.some(p => p.includes(stageCal.parent.slice(0, 6))),
    JSON.stringify({ pars: stageCal.pars, parent: stageCal.parent }));
  const dayRow = dayRows.find(r => r.txt.includes(stageCal.stage));
  check('右侧当天清单按阶段列，父任务降级成归属标签',
    !!dayRow && dayRow.parent.includes(stageCal.parent),
    JSON.stringify({ row: dayRow && dayRow.txt.slice(0, 90), parent: dayRow && dayRow.parent }));

  /* ---------- 6.0 一天里多条活要全露出来，不能折叠成 +N ---------- */
  /* 以前一格硬截 4 条，剩下的只写个 +N。常规任务没有优先级，排序天然靠后，
     于是「同一天活一多，常规那条在日历上不见了」——而 +N 本身也不是个能点开的东西。
     这里拿 5 条新任务把格子占满，钉住「一条都不许吞」。 */
  const PACKDAY = '2026-12-18';
  const packed = await js(`(async()=>{
    for(let i=1;i<=5;i++){
      await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({me:'1012',tasks:[{id:'t_e2e_pack_'+i,ownerNo:'1012',assigneeNo:'1012',
          type:'temp',title:'E2E挤格'+i,start:'${PACKDAY}',end:'${PACKDAY}',status:'todo'}]})});
    }
    await refresh(true);
    calCursor='${PACKDAY}'; selDay='${PACKDAY}'; view='calendar'; render();
    const cell=document.querySelector('.cell[data-date="${PACKDAY}"]');
    if(!cell) return {err:'日历里没有这一天'};
    cell.click();
    return {total:Number(cell.dataset.total||0),
      labels:[...cell.querySelectorAll('.chip.cal .lbl')].map(x=>x.textContent),
      more:(cell.querySelector('.more')||{}).textContent||''};
  })()`);
  await sleep(600); await shot('16-packday');
  const packRows = await js(`[...document.querySelectorAll('#view .tlist .trow')]
    .map(r=>r.innerText.replace(/\\s+/g,' ').trim()).filter(x=>x.includes('E2E挤格')).length`);
  check('同一天 5 条活全部铺在格子里，一条都不折叠',
    !packed.err && packed.total >= 5 && packed.labels.filter(x => x.includes('E2E挤格')).length === 5
      && packed.more === '',
    JSON.stringify(packed));
  check('格子里的条目和右侧当天清单对得上（不会只在格子里少、清单里多）',
    !packed.err && Number(packRows) === 5, '右侧清单 ' + packRows + ' 条');
  await js(`(async()=>{ await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({me:'1012',del:{tasks:['t_e2e_pack_1','t_e2e_pack_2','t_e2e_pack_3','t_e2e_pack_4','t_e2e_pack_5']}})});
    return 'ok'; })()`);

  /* ---------- 6.0b 点日历上的卡片 = 定位到右侧那一条，不直接弹详情 ---------- */
  /* 人点日历上的卡，多半是想改状态/看今天还剩什么，弹一整页详情等于把人赶走；
     详情该留给那一行右边的「详情」。所以这里钉三件事：
     格子里的卡点了不跳详情、右边当天清单换成被点的那天并高亮该条、那一行能就地改状态。 */
  const FCUS = '2026-12-17';
  await js(`(async()=>{ await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({me:'1012',tasks:[{id:'t_e2e_focus',ownerNo:'1012',assigneeNo:'1012',
      type:'temp',title:'E2E定位试验',start:'${FCUS}',end:'${FCUS}',status:'todo'}]})});
    return 'ok'; })()`);
  await goto(BASE);
  await waitFor(`typeof S!=='undefined' && S && S.me && S.me.no`, 8000);
  await js(`(function(){
    view='calendar'; calCursor=monthStart('${FCUS}');
    /* 故意把右边停在前一天，验证点卡会把右边的日子带过去 */
    selDay='2026-12-16'; focusKey=''; render();
    const chip=document.querySelector('.chip.cal[data-id="t_e2e_focus"]');
    if(chip) chip.click();
    return 'ok';
  })()`);
  await sleep(700);
  const focusVis = await js(`(function(){
    const row=document.querySelector('#view .tlist .trow[data-key="t_e2e_focus|"]');
    const h2=document.querySelector('#view .card-h h2');
    return {view:view, detailOpen:!!document.querySelector('#dTitle'),
      row:!!row, focused:!!(row&&row.classList.contains('focus')),
      selDay:selDay, head:(h2||{}).textContent||'',
      statusSel:!!(row&&row.querySelector('select[data-act="qstatus"]')),
      detailBtn:!!(row&&row.querySelector('[data-act="open"]')),
      txt:row?row.innerText.replace(/\\s+/g,' ').trim().slice(0,40):''};
  })()`);
  check('点日历上的卡片不弹详情，留在日历页',
    !!focusVis && focusVis.detailOpen === false && focusVis.view === 'calendar',
    JSON.stringify(focusVis));
  check('点卡片会把右侧清单切到那一天，并高亮被点的那一条',
    !!focusVis && focusVis.selDay === FCUS && focusVis.row === true && focusVis.focused === true
      && focusVis.head.includes('12-17'),
    JSON.stringify(focusVis));
  check('定位到的那一行能就地改状态，详情另有入口',
    !!focusVis && focusVis.statusSel === true && focusVis.detailBtn === true,
    JSON.stringify({ sel: focusVis && focusVis.statusSel, btn: focusVis && focusVis.detailBtn }));
  await shot('16b-cal-focus');
  await js(`(async()=>{ await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({me:'1012',del:{tasks:['t_e2e_focus']}})});
    return 'ok'; })()`);
  await goto(BASE);
  await waitFor(`typeof S!=='undefined' && S && S.me && S.me.no`, 8000);

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
  /* 别拿「今天之后第一个周末」凑数：跨月长的常规活（月度薪酬那类）中间会断档，
     专项阶段又只盖住自己的那几周，两边不一定落在同一个周末。
     各找一个确实被盖住的休息日，否则测出来的是「这天本来就没活」，等于没测。 */
  await nav('calendar');
  const restSpots = await js(`(function(){
    const sp = d => S.tasks.some(t=>isMineTask(t)&&t.type==='special'&&(t.stages||[]).some(s=>!s.done&&s.start&&s.end&&s.start<=d&&s.end>=d));
    const rt = d => S.tasks.some(t=>isMineTask(t)&&t.type==='routine'&&(t.stages||[]).length&&t.start<=d&&t.end>=d);
    let a='', b='';
    for(let d=TODAY;d<=addDays(TODAY,90)&&!(a&&b);d=addDays(d,1)){
      if(isWorkday(d)) continue;
      if(!a&&sp(d)) a=d;
      if(!b&&rt(d)) b=d;
    }
    return {specialDay:a, routineDay:b};
  })()`);
  const probeRest = async (day) => {
    const r = await js(`(function(){
      calCursor=monthStart('${day}'); selDay=TODAY; view='calendar'; render();
      const cell=document.querySelector('.cell[data-date="${day}"]');
      if(!cell) return {err:'日历里没有这天'};
      const chips=cell.querySelectorAll('.chip.cal').length;
      cell.click();
      return {date:'${day}', chips:chips};
    })()`);
    await sleep(350);
    r.panel = await js(`(function(){
      return {rows:document.querySelectorAll('#view .tlist .trow').length,
        empty:(document.querySelector('#view .tlist .empty')||{}).textContent||''};
    })()`);
    return r;
  };
  const restSp = await probeRest(restSpots.specialDay || TODAY);
  await shot('16-restday');
  check('被专项阶段盖住的周末，也不铺阶段条（格子和右栏都空）',
    !!restSpots.specialDay && !restSp.err && restSp.chips === 0 &&
    restSp.panel.rows === 0 && restSp.panel.empty.includes('休息日'),
    JSON.stringify({ spots: restSpots, restSp }));
  const restRt = await probeRest(restSpots.routineDay || TODAY);
  check('常规的跨月区间也不整段铺到周末',
    !!restSpots.routineDay && !restRt.err && restRt.chips === 0 &&
    restRt.panel.rows === 0 && restRt.panel.empty.includes('休息日'),
    JSON.stringify({ spots: restSpots, restRt }));

  /* ---------- 6.2 阶段能就地改名称和日期，不用删了重建 ---------- */
  /* 挑一个「至少有一段没子任务、没勾完成、够缩两天」的专项：有子任务的阶段日期是派生的、
     输入框 disabled；勾完完成的阶段日期被锁（已经发生的计划不能再挪）；不足两天的阶段缩不了。 */
  const stOpen = await js(`(function(){
    const pick = ss => ss.findIndex(s => !s.done && s.start && s.end && s.end >= addDays(s.start, 2)
      && !ss.some(k => k.pid === s.id));
    const t=S.tasks.find(x=>{const ss=x.stages||[];
      return x.type==='special'&&x.ownerNo===S.me.no&&ss.length>=2&&ss.every(s=>s.start&&s.end)
        && pick(ss) >= 0;});
    if(!t) return {err:'没有可编辑阶段的专项'};
    openTaskPage(t.id);
    const ss=t.stages;
    const idx=pick(ss);
    const row=[...document.querySelectorAll('#view .stage')].find(r=>{
      const b=r.querySelector('[data-act=stage-edit]');
      return b&&Number(b.dataset.idx)===idx;});
    if(!row) return {err:'阶段行没有「改」入口'};
    row.querySelector('[data-act=stage-edit]').click();
    const box=document.querySelector('#view .sedit');
    if(!box) return {err:'点了「改」没展开编辑框'};
    const s=ss[idx];
    return {id:t.id, idx, oldName:s.name, oldStart:s.start, oldEnd:s.end,
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
    !stOpen.err && stBad.msg.includes('早于开始') && stBad.name === stOpen.oldName,
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
  const stAfter = stOpen.err ? null : await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
    const t=s.tasks.find(x=>x.id==='${stOpen.id}');const st=t.stages[${stOpen.idx != null ? stOpen.idx : 0}];
    return {name:st.name, start:st.start, end:st.end}})()`);
  check('改完立刻落库：名称、开始、结束三样都按新值存下来',
    !!stAfter && stAfter.name === '改名后的阶段' &&
    stAfter.start === addDaysStr(stOpen.oldStart, 1) && stAfter.end === addDaysStr(stOpen.oldEnd, -1),
    JSON.stringify({ before: { name: stOpen.oldName, start: stOpen.oldStart, end: stOpen.oldEnd }, after: stAfter, msg: stFix.msg }));
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

  /* ---------- 6.9 阶段区间：跨年、中间段、尾段、相接、改期自身（v0.9.2 事故回归） ----------
     这一组盯的是「阶段是一串跨年区间，不是只在最后一段后面追加」。
     老实现按数组相邻两项判重叠，新增段又一律 push 到最后，于是永远和最后一段配成一对，
     '2026-11-07' <= '2027-06-30' 必然成立——用户填的是合法空档，却被报「占到 6月30日」。 */
  const IV = 't_e2e_interval';
  const ivPush = async (b) => (await apiAs('1012', '/api/sync', Object.assign({ me: '1012' }, b))).json;
  const ivRow = () => dbGet('SELECT start_date, end_date, stages FROM task WHERE id=?', IV);
  const ivCount = () => { const r = ivRow(); return r ? JSON.parse(r.stages || '[]').length : -1; };
  const ivStages = [
    { id: 'iv1', name: '一、需求梳理', start: '2026-07-03', end: '2026-09-30' },
    { id: 'iv2', name: '二、指标口径', start: '2026-10-01', end: '2026-11-06' },
    { id: 'iv3', name: '三、治理落标', start: '2026-11-09', end: '2027-01-29' },
    { id: 'iv4', name: '四、数据回灌', start: '2027-02-01', end: '2027-04-30' },
    { id: 'iv5', name: '五、受治理问数', start: '2027-05-03', end: '2027-06-30' }
  ];
  const ivBody = (over) => Object.assign({
    id: IV, ownerNo: '1012', assigneeNo: '1012', type: 'special', title: 'E2E阶段区间',
    start: '2026-07-03', end: '2027-06-30', status: 'doing', stages: ivStages.map(s => Object.assign({}, s))
  }, over || {});
  await ivPush({ del: { tasks: [IV] } });
  const ivMk = await ivPush({ tasks: [ivBody()] });
  check('阶段区间夹具：跨年五段、段间留空档（11-06 与 11-09 之间空两天）能存',
    !(ivMk.errors || []).length && ivCount() === 5, JSON.stringify(ivMk));

  await goto(BASE); await sleep(1000);
  await js(`(function(){openTaskPage('${IV}');return 1})()`);
  await sleep(600);
  const ivAdd = async (name, s, e) => {
    await js(`(function(){document.querySelector('#sName').value=${JSON.stringify(name)};
      document.querySelector('#sStart').value='${s}';document.querySelector('#sEnd').value='${e}';
      document.querySelector('[data-act="stage-add"]').click();return 1})()`);
    await sleep(1200);
    return await js(`(function(){return {msg:(document.querySelector('#toast')||{}).textContent||''}})()`);
  };

  const ivA = await ivAdd('数据实时接入', '2026-11-07', '2026-11-08');
  const ivRowA = ivRow() || { stages: '[]' };
  const ivIdxA = JSON.parse(ivRowA.stages || '[]').findIndex(s => s.name === '数据实时接入');
  check('合法空档放行：11-07→11-08 落在 11-06 与 11-09 之间，不再误报跨年重叠，并按时间排到第 3 段',
    ivCount() === 6 && ivIdxA === 2 && ivA.msg.includes('已添加'),
    JSON.stringify({ msg: ivA.msg, idx: ivIdxA, n: ivCount() }));

  /* 只压中间那一段（11-01→11-06 全落在「二、指标口径」里），避免同时碰到过渡段，
     这样断言能证明「不是拿最后一段当邻居」这件事，而不是碰巧撞上别的段。 */
  const ivB = await ivAdd('压中间段', '2026-11-01', '2026-11-06');
  check('压到中间段：拦下，点名两段并给出带年份的重叠区间',
    ivB.msg.includes('压上了') && ivB.msg.includes('第 2 段「二、指标口径」')
      && ivB.msg.includes('2026-11-01 到 2026-11-06') && ivCount() === 6,
    JSON.stringify({ msg: ivB.msg, n: ivCount() }));

  const ivC = await ivAdd('压最后段', '2027-06-20', '2027-07-05');
  check('压到最后段：同样拦下——判定跟数组顺序无关，不再拿最后一段当邻居',
    ivC.msg.includes('五、受治理问数') && ivC.msg.includes('2027-06-20') && ivCount() === 6,
    JSON.stringify({ msg: ivC.msg, n: ivCount() }));

  const ivD = await ivAdd('尾段之后', '2027-07-01', '2027-07-02');
  const ivStD = JSON.parse((ivRow() || { stages: '[]' }).stages || '[]');
  check('首尾相接不算冲突：07-01 接在 06-30 后面放行，任务周期跟着包络延到 07-02',
    ivStD.length === 7 && ivStD[6].name === '尾段之后' && (ivRow() || {}).end_date === '2027-07-02',
    JSON.stringify({ n: ivStD.length, end: (ivRow() || {}).end_date, msg: ivD.msg }));

  await js(`(function(){document.querySelector('#view [data-act="stage-edit"]').click();return 1})()`);
  await sleep(300);
  await js(`(function(){document.querySelector('#view .sedit [data-act="stage-save"]').click();return 1})()`);
  await sleep(1200);
  const ivE = await js(`(function(){
    const t=JSON.parse(JSON.stringify(S.tasks.find(x=>x.id==='${IV}')));
    return {msg:(document.querySelector('#toast')||{}).textContent||'', first:t.stages[0]}})()`);
  const ivRowE = JSON.parse((ivRow() || { stages: '[]' }).stages || '[]');
  check('改期到自己原来的日期：放行（自身不参与配对），第一段日期不变',
    ivE.msg.includes('已更新') && ivRowE[0].start === '2026-07-03' && ivRowE[0].end === '2026-09-30',
    JSON.stringify({ msg: ivE.msg, first: ivRowE[0] }));

  /* 服务端才是判定者：绕过界面直接塞脏数据，必须被拒且不落库 */
  const ivF = await ivPush({ tasks: [ivBody({ stages: ivStages.map((s, i) => Object.assign({}, s, i === 2 ? { start: '2026-11-05' } : {})) })] });
  check('直调 /api/sync 塞重叠段：被服务端拒收，库里的阶段不动',
    (ivF.errors || []).some(m => m.includes('时间重叠')) && ivCount() === 7,
    JSON.stringify({ errors: ivF.errors, n: ivCount() }));

  const ivG = await ivPush({ tasks: [ivBody({ stages: ivStages.concat([{ id: 'iv6', pid: 'iv2', name: '越界子任务', start: '2026-09-01', end: '2026-09-02' }]) })] });
  check('直调 /api/sync 塞子任务到父阶段窗口外：被服务端拒收',
    (ivG.errors || []).some(m => m.includes('超出所属阶段')) && ivCount() === 7,
    JSON.stringify({ errors: ivG.errors, n: ivCount() }));

  const ivH = await ivPush({ tasks: [ivBody({ end: '2027-05-30' })] });
  check('直调 /api/sync 让任务周期短于阶段包络：被服务端拒收',
    (ivH.errors || []).some(m => m.includes('任务周期')) && ivCount() === 7,
    JSON.stringify({ errors: ivH.errors, n: ivCount() }));

  await ivPush({ del: { tasks: [IV] } });
  check('阶段区间夹具已清理', !ivRow(), String(!!ivRow()));
  await js(`(()=>{const b=document.querySelector('.td-head [data-act=close]');if(b)b.click();return 'ok'})()`);
  await sleep(400);
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
  const afterDrag = drag.err ? null : await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
  const afterPast = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
  const stageAfter = stageDrag.err ? null : await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
    qstDb = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
    rqDb = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
  check('来源恢复最初的底色和字色：发布蓝、常规青、专项紫、临时橙',
    Object.keys(srcExpected).every(k=>!!srcVis[k]&&srcVis[k].bg===srcExpected[k].bg&&srcVis[k].color===srcExpected[k].color),
    JSON.stringify(srcVis));
  check('图例分开写来源与状态，并列出已逾期',
    cv.legend.includes('来源') && cv.legend.includes('状态') &&
    ['发布','常规','专项','临时'].every(x=>cv.legend.includes(x)) &&
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
  const catDb = catTest.err ? null : await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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

  /* 真按一次回车：不是手动 dispatch submit，走浏览器的隐式提交（按钮已改成 type=button） */
  await js(`(function(){const t=document.querySelector('#qTitle'); t.focus(); t.value='自检临时任务'; return document.activeElement.id})()`);
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(2200);
  const tempOk = (await txt('#view')).includes('自检临时任务');
  check('空态下按回车可快速建临时任务', tempOk);
  const tempDb = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
    const x=(s.tasks||[]).find(t=>t.title==='自检临时任务');
    return x?{type:x.type,time:x.time,std:x.std,cat1:x.cat1,imp:x.imp}:null})()`);
  check('回车直接建：字段走默认（时间空、达成标准空、其他/临时、无优先级）',
    !!tempDb && tempDb.type === 'temp' && tempDb.time === '' && tempDb.std === '' && tempDb.cat1 === '其他' && tempDb.imp === null,
    JSON.stringify(tempDb));

  /* 快速录入条选日期：建明天的任务要落在明天，且不能混进今天的清单 */
  const dayTest = await js(`(function(){
    const target = addDays(TODAY, 1);
    document.querySelector('#qTitle').value='自检明日任务';
    document.querySelector('#qDate').value=target;
    document.querySelector('#quickForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    return {today:TODAY, target, label:fmt(target)};
  })()`);
  await sleep(350);
  const dayToast = await js(`(document.querySelector('#toast')||{}).textContent||''`);
  await sleep(2200);
  const dayDb = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
    const x=(s.tasks||[]).find(t=>t.title==='自检明日任务');
    return {start:x?x.start:null, end:x?x.end:null, type:x?x.type:null}})()`);
  const dayList = await js(`(document.querySelector('#view .tlist')||{}).innerText||''`);
  const chipInfo = await js(`(function(){
    const l=document.querySelector('#qDateLabel'), h=document.querySelector('#qHint'), d=document.querySelector('#qDate');
    return {chip:l?l.textContent:'', date:d?d.value:null, hint:h?h.textContent:'', hintShown:h?getComputedStyle(h).display!=='none':false}})()`);
  check('快速录入条选明天：任务落在明天，不是写死今天',
    !!dayDb.start && dayDb.start === dayTest.target && dayDb.end === dayTest.target && dayDb.type === 'temp',
    JSON.stringify({ ...dayTest, ...dayDb }));
  check('建的不是今天时，提示写明落在哪一天',
    dayToast.includes(dayTest.label) && !dayToast.includes('今日待办'),
    JSON.stringify({ dayToast, expect: dayTest.label }));
  check('明天的任务不进今日清单，日期 chip 记住上次选择并显示「明天」',
    !dayList.includes('自检明日任务') && chipInfo.chip === '明天' && chipInfo.date === dayTest.target,
    JSON.stringify({ inList: dayList.includes('自检明日任务'), ...chipInfo }));
  check('非今天时按钮左侧提示「将建到哪天」',
    chipInfo.hintShown && chipInfo.hint.includes(dayTest.label),
    JSON.stringify({ hint: chipInfo.hint, shown: chipInfo.hintShown }));

  /* 时间收成图标：填了显示 09:30，行高保持 32 */
  const timeUi = await js(`(function(){const t=document.querySelector('#qTime');
    t.value='09:30'; t.dispatchEvent(new Event('change',{bubbles:true}));
    const b=document.querySelector('.q-time-btn');
    return {text:(document.querySelector('#qTimeText')||{}).textContent||'',
      btnW:+b.getBoundingClientRect().width.toFixed(1),
      rowH:+document.querySelector('#quickForm').getBoundingClientRect().height.toFixed(1)}})()`);
  check('时间默认收成图标，填后显示 09:30 且不把行撑高',
    timeUi.text === '09:30' && timeUi.rowH <= 33, JSON.stringify(timeUi));

  /* 刷新后「上次选择」必须失效，回到今天 */
  await goto(BASE);
  await waitFor(`typeof S!=='undefined' && S && S.me && S.me.no`, 8000);
  const fresh = await js(`(function(){const d=document.querySelector('#qDate'), l=document.querySelector('#qDateLabel');
    return {date:d?d.value:null, today:TODAY, label:l?l.textContent:null}})()`);
  check('刷新页面后日期回到今天', fresh.date === fresh.today && fresh.label === '今天', JSON.stringify(fresh));

  /* 按钮 = 细致设置：不建任务，只打开完整弹窗，并把标题/日期/时间带过去 */
  const detail = await js(`(async ()=>{
    const before = S.tasks.length;
    const d = document.querySelector('#qDate'), t = document.querySelector('#qTime');
    document.querySelector('#qTitle').value = '自检细节任务';
    d.value = addDays(TODAY, 1); d.dispatchEvent(new Event('change',{bubbles:true}));
    t.value = '10:15'; t.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('[data-act=qdetail]').click();
    const s = await (await fetch('/api/state?me=1012')).json();
    return {before, afterLocal:S.tasks.length, afterServer:(s.tasks||[]).length,
      open:document.querySelector('#modalWrap').classList.contains('show'),
      title:document.querySelector('#f_title').value,
      start:document.querySelector('#f_start').value,
      end:document.querySelector('#f_end').value,
      time:document.querySelector('#f_time').value,
      target:addDays(TODAY,1)};
  })()`);
  check('点「+ 临时任务…」不直接建任务，打开已预填的完整弹窗',
    detail.open && detail.afterLocal === detail.before && detail.afterServer === detail.before &&
    detail.title === '自检细节任务' && detail.start === detail.target &&
    detail.end === detail.target && detail.time === '10:15',
    JSON.stringify(detail));

  /* 取消不能把录入条里已经敲好的内容烧掉；再点一次仍应带着它打开 */
  await js(`document.querySelector('#modal [data-act=modal-cancel]').click();'ok'`);
  await sleep(300);
  const afterCancel = await js(`(function(){return {open:document.querySelector('#modalWrap').classList.contains('show'),
    title:document.querySelector('#qTitle').value, n:S.tasks.filter(t=>t.title==='自检细节任务').length}})()`);
  check('取消弹窗：不建任务，录入条里的标题还在',
    !afterCancel.open && afterCancel.n === 0 && afterCancel.title === '自检细节任务',
    JSON.stringify(afterCancel));
  await js(`document.querySelector('[data-act=qdetail]').click();'ok'`);
  const reopened = await js(`(function(){return {open:document.querySelector('#modalWrap').classList.contains('show'),
    title:document.querySelector('#f_title').value, time:document.querySelector('#f_time').value}})()`);
  check('再次打开弹窗仍然预填标题与时间',
    reopened.open && reopened.title === '自检细节任务' && reopened.time === '10:15',
    JSON.stringify(reopened));

  await js(`(function(){document.querySelector('#f_std').value='周会上讲清楚本周结论';
    document.querySelector('#f_imp').value='3';
    document.querySelector('#f_urg').value='2';
    document.querySelector('#modal [data-act=modal-ok]').click();return 'ok'})()`);
  await sleep(2200);
  const detailDb = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
    const x=(s.tasks||[]).find(t=>t.title==='自检细节任务');
    return x?{type:x.type,start:x.start,end:x.end,time:x.time,std:x.std,imp:x.imp,urg:x.urg,cat1:x.cat1}:null})()`);
  check('弹窗提交后落库字段与填写一致（时间点/达成标准/优先级/分类）',
    !!detailDb && detailDb.type === 'temp' && detailDb.start === detail.target &&
    detailDb.end === detail.target && detailDb.time === '10:15' &&
    detailDb.std === '周会上讲清楚本周结论' && detailDb.imp === 3 && detailDb.urg === 2 &&
    detailDb.cat1 === '其他',
    JSON.stringify(detailDb));

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
      created = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
  const ruleInDb = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
    const ru=(s.rules||[]).find(x=>x.title==='自检规则');
    if(!ru) return {rule:false, inst:0};
    return {rule:true, inst:(s.tasks||[]).filter(t=>t.routineId===ru.id).length}})()`);
  check('空态下可新建常规规则', ruleInUi && ruleInDb.rule && ruleInDb.inst > 0,
    ruleDiag || `界面=${ruleInUi} 库=${JSON.stringify(ruleInDb)}`);

  await goto(BASE);
  await waitFor(`typeof S!=='undefined' && S && S.me && S.me.no`, 8000);
  await sleep(400);
  const persistedTask = await js(`(function(){return document.body.innerText.includes('自检临时任务')})()`);
  const persistDiag = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
    return {view:(typeof view!=='undefined'?view:'?'), login:!!document.querySelector('#auth.show'),
      inDb:(s.tasks||[]).some(t=>t.title==='自检临时任务'),
      localMe:(window.S&&S.me?S.me.no:null),
      lsMe:localStorage.getItem('pm_mvp_me')}})()`);
  await nav('routine');
  await js(`(()=>{const b=document.querySelector('[data-act=rtab][data-tab=day]');if(b)b.click();return 'ok'})()`);
  await sleep(600);
  const ruleAlive = (await txt('#view')).includes('自检规则');
  check('新建数据刷新后仍在', persistedTask && ruleAlive, `任务=${persistedTask} 规则=${ruleAlive} 现场=${JSON.stringify(persistDiag)}`);

  /* ---------- 7.4b 年常规：每年几月几日，今年与明年各一次 ---------- */
  await nav('routine');
  const yTab = await js(`(()=>{const b=document.querySelector('[data-act=rtab][data-tab=year]');if(!b)return false;b.click();return true})()`);
  await sleep(500);
  check('年常规页签存在且可切换', yTab === true, String(yTab));

  await js(`(function(){const bs=[...document.querySelectorAll('[data-act=new-rule]')];
    const b=bs.find(x=>x.offsetParent!==null)||bs[0]; b.click(); return 'ok'})()`);
  await waitFor(`document.querySelector('#r_title')`, 4000);
  await js(`(function(){document.querySelector('#r_title').value='自检年规则';
    const cy=document.querySelector('#r_cycle'); cy.value='year'; cy.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`);
  await sleep(500);
  const yForm = await js(`(function(){
    const row=document.querySelector('#stepRows .srow');
    if(!row) return {err:'没有节点行'};
    row.querySelector('.sname').value='年度体检';
    const m=row.querySelector('.smonthno'); if(!m) return {err:'没有月份选择'};
    m.value='8'; row.querySelector('.sday').value='31'; row.querySelector('.spol').value='prev';
    return {month:m.value, day:row.querySelector('.sday').value}})()`);
  check('年节点行有「月 / 日」输入', !yForm.err && yForm.month === '8' && yForm.day === '31', JSON.stringify(yForm));
  await js(`document.querySelector('#modal [data-act=modal-ok]').click();'ok'`);

  /* 期望年份与生成窗口同口径：窗口起点后最近的一个 8/31 */
  const expY = await js(`(function(){const from=monthStart(addDays(TODAY,-40));let y=Number(TODAY.slice(0,4));
    while((y+'-08-31')<from) y++; return y})()`);
  let yState = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    yState = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
      const ru=(s.rules||[]).find(x=>x.title==='自检年规则');
      if(!ru) return null;
      return {rule:ru, inst:(s.tasks||[]).filter(t=>t.routineId===ru.id)
        .sort((a,b)=>a.planDate<b.planDate?-1:1)
        .map(t=>({id:t.id,plan:t.planDate,start:t.start,status:t.status}))}})()`);
    if (yState && yState.inst.length) break;
  }
  check('年常规生成窗口内的那一次：id=ri_<rule>_YYYY、plan_date=YYYY-08-31',
    !!yState && yState.inst.length === 1 &&
    yState.inst[0].id === `ri_${yState.rule.id}_${expY}` && yState.inst[0].plan === `${expY}-08-31`,
    JSON.stringify({ expY, yState }));

  const yCal = await js(`(function(){calMode='month';calCursor='${expY}-08-01';render();
    return document.querySelector('#view').innerText.includes('自检年规则')})()`);
  check('年实例在日历目标月份可见', yCal === true, String(yCal));
  /* 看完要把日历拨回今天，后面的拖拽/改期断言都以今天为基准 */
  await js(`(function(){calMode='month';calCursor=monthStart(TODAY);selDay=TODAY;render();return 1})()`);

  const yIdem = await js(`(async()=>{await (await fetch('/api/state?me=1012')).json();
    const s=await (await fetch('/api/state?me=1012')).json();
    const ru=(s.rules||[]).find(x=>x.title==='自检年规则');
    return (s.tasks||[]).filter(t=>t.routineId===ru.id).length})()`);
  check('maintain 幂等：连续两次取 state 后年实例仍是 1 条', yIdem === 1, String(yIdem));

  /* 改规则：日期改到 8/30，实例不能被删掉，id 与年份不变、plan_date 跟着变 */
  await nav('routine');
  await js(`(()=>{const b=document.querySelector('[data-act=rtab][data-tab=year]');if(b)b.click();return 1})()`);
  await sleep(400);
  const yEditOpen = await js(`(()=>{const c=[...document.querySelectorAll('.rule-card')].find(x=>x.innerText.includes('自检年规则'));
    if(!c) return false; c.querySelector('[data-act=rule-edit]').click(); return true})()`);
  await sleep(400);
  await js(`(()=>{const row=document.querySelector('#stepRows .srow');if(row)row.querySelector('.sday').value='30';return 1})()`);
  await js(`document.querySelector('#modal [data-act=modal-ok]').click();'ok'`);
  let yAfter = null;
  for (let i = 0; i < 15; i++) {
    await sleep(400);
    yAfter = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
      const ru=(s.rules||[]).find(x=>x.title==='自检年规则');
      return ru?(s.tasks||[]).filter(t=>t.routineId===ru.id).map(t=>({id:t.id,plan:t.planDate})):null})()`);
    if (yAfter && yAfter.length === 1 && yAfter[0].plan === `${expY}-08-30`) break;
  }
  check('改规则后年实例仍在（id 不变、plan_date 改到 08-30）',
    !!yEditOpen && !!yAfter && yAfter.length === 1 &&
    yAfter[0].id === `ri_${yState.rule.id}_${expY}` && yAfter[0].plan === `${expY}-08-30`,
    JSON.stringify({ yEditOpen, yAfter }));

  /* 日/周/月回归：周期 key 形态一条都没变 */
  const reg = await js(`(async()=>{
    const rules=[
      {id:'r_e2e_day', title:'自检日规则', cycle:'day', policy:'none', active:true, steps:[{name:'',time:'09:30',policy:'none'}]},
      {id:'r_e2e_week', title:'自检周规则', cycle:'week', policy:'prev', active:true, steps:[{name:'',weekday:5,time:'17:00',policy:'prev'}]},
      {id:'r_e2e_month', title:'自检月规则', cycle:'month', policy:'prev', active:true, steps:[{name:'',day:5,time:'09:00',policy:'prev'}]}
    ];
    const r=await (await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({me:'1012',rules})})).json();
    if(!r.ok) return {err:r.errors||r};
    const s=await (await fetch('/api/state?me=1012')).json();
    const pick=id=>(s.tasks||[]).filter(t=>t.routineId===id).map(t=>t.id);
    return {day:pick('r_e2e_day'),week:pick('r_e2e_week'),month:pick('r_e2e_month')}})()`);
  const oneKey = (ids, re) => Array.isArray(ids) && ids.length > 0 && ids.every(id => re.test(id));
  check('日/周/月周期 key 形态不变（日=YYYY-MM-DD、周=YYYY-MM-DD、月=YYYY-MM）',
    oneKey(reg.day, /^ri_r_e2e_day_\d{4}-\d{2}-\d{2}$/) &&
    oneKey(reg.week, /^ri_r_e2e_week_\d{4}-\d{2}-\d{2}$/) &&
    oneKey(reg.month, /^ri_r_e2e_month_\d{4}-\d{2}$/), JSON.stringify(reg));

  const badRule = await js(`(async()=>{
    const post=async body=>{const r=await (await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();return (r.errors||[]).join('|')};
    return {
      quarter: await post({me:'1012',rules:[{id:'r_e2e_bad',title:'自检坏规则',cycle:'quarter',policy:'prev',active:true,steps:[]}]}),
      noMonth: await post({me:'1012',rules:[{id:'r_e2e_bad2',title:'自检坏年规则',cycle:'year',policy:'prev',active:true,steps:[{name:'',day:3,time:'09:00',policy:'prev'}]}]})
    }})()`);
  check('服务端拒收未知周期与「缺几月几日」的年规则，并回可读原因',
    /quarter/.test(badRule.quarter) && /几月几日/.test(badRule.noMonth), JSON.stringify(badRule));

  const yClean = await js(`(async()=>{
    const del={rules:[${JSON.stringify(yState.rule.id)},'r_e2e_day','r_e2e_week','r_e2e_month']};
    await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({me:'1012',del})});
    const s=await (await fetch('/api/state?me=1012')).json();
    return (s.tasks||[]).filter(t=>del.rules.includes(t.routineId)).length})()`);
  check('删除年规则后它的实例一起清掉', yClean === 0, String(yClean));
  /* 后面的 7.5 要删的是「日常规」那条，把页签切回 day */
  await js(`(()=>{const b=document.querySelector('[data-act=rtab][data-tab=day]');if(b)b.click();return 1})()`);
  await sleep(500);

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
    goneDb = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
    const n = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
      afterStop = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
      reOn = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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
  await asUser('1002');
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
  /* 这三个助手原来在页面里 fetch，靠传 me 冒充身份。
     认证上线后服务端只认 cookie，遂改成 Node 侧带该身份的 sid 调用——
     这样「以 1002 身份写库」不再依赖浏览器当前登录的是谁。 */
  const push = async (m, b) => {
    const r = await apiAs(m, '/api/sync', Object.assign({ me: m }, b));
    return !!(r.json && r.json.ok === true);
  };
  /* 同上，但把整个回包带回来：`ok:true` 只代表请求没炸，被拒的条目在 errors 里 */
  const pushJ = async (m, b) => (await apiAs(m, '/api/sync', Object.assign({ me: m }, b))).json;
  /* 0.7.0 的动作接口：接收 / 派发 / 加入待办 / 勾选 / 改总截止 / 提醒已读 */
  const act = async (p, b) => (await apiAs(b.me, p, b)).json;
  await asUser('1012');
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
  check('上级在发布任务里看到承接后的进展', !!carry && carry.id === CARRIED && carry.txt.includes('50%'),
    JSON.stringify(carry).slice(0, 160));

  /* 行尾按钮：说的是「查看」，不是含糊的「管理」 */
  const rowBtn = await js(`(function(){const b=[...document.querySelectorAll('#view table button[data-act="open"]')][0];
    return b ? b.innerText.trim() : ''})()`);
  check('发布任务行尾按钮叫「查看」而不是「管理」', rowBtn === '查看', rowBtn);

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
  check('承接任务对上级只读：没有表单控件，改用键值表展示，且标注「承接」而非「发布」',
    !!ro && ro.readonly === true && String(ro.tags).includes('承接') && !String(ro.tags).includes('发布')
      && ro.formFields <= 1 && ro.kv >= 5,
    JSON.stringify(ro).slice(0, 200));
  await shot('11-assign-carry');
  await js(`document.querySelector('.td-head [data-act="close"]').click();'ok'`);
  await sleep(300);

  await push('1012', { del: { tasks: [SRC] } });
  await push('1002', { del: { tasks: [CARRIED, SRC] } });

  /* ---------- 9.3 「待接收」只由「接收」解除，不靠改状态顺带 ----------
     0.7.0 之前：状态一改成进行中，服务端顺手把 intake 也标成已接收。
     现在接收 = 所有权转移，是一个明确的动作；没接收之前这条根本不归承接人，
     他连改都改不动——所以「进行中 + 待接收」这种矛盾组合从源头上不可能出现。 */
  const AUTO = 't_e2e_auto';
  const AUTO_T = { ownerNo: '1012', assigneeNo: '1002', type: 'assign',
    title: 'E2E自动落定', start: '2026-11-03', end: '2026-11-06' };
  await push('1012', { tasks: [Object.assign({ id: AUTO, status: 'todo', intakeStatus: 'pending' }, AUTO_T)] });
  const autoPre = await pushJ('1002', { tasks: [Object.assign({ id: AUTO, status: 'doing', intakeStatus: 'pending' }, AUTO_T)] });
  /* 这几处读的是 1002 的库，而页面这时是 1012 的身份。
     认证上线后 `?me=` 与会话不一致就是 403（设计如此），所以库里的事实改从 Node 侧读。 */
  const autoPreDb = await js(`(function(){const j=${JSON.stringify(await stateAs('1002'))};
    const t=(j.tasks||[]).find(x=>x.id==='${AUTO}'); return t?{status:t.status,intake:t.intakeStatus,owner:t.ownerNo}:null})()`);
  check('还没接收就想把它推进到进行中：写不进去，仍旧挂在发布人那边等接收',
    (autoPre.rows | 0) === 0 && (autoPre.errors || []).length >= 1
      && !!autoPreDb && autoPreDb.status === 'todo' && autoPreDb.intake === 'pending' && autoPreDb.owner === '1012',
    JSON.stringify({ rows: autoPre.rows, errors: autoPre.errors, db: autoPreDb }));

  const autoAcc = await act('/api/task/accept', { me: '1002', id: AUTO });
  const autoAccDb = await js(`(function(){const j=${JSON.stringify(await stateAs('1002'))};
    const t=(j.tasks||[]).find(x=>x.id==='${AUTO}'); return t?{status:t.status,intake:t.intakeStatus,owner:t.ownerNo,type:t.type}:null})()`);
  check('接收之后才归他：所有权转过去、进他的专项，也没多出第二条任务',
    !!autoAcc.ok && !!autoAccDb && autoAccDb.owner === '1002' && autoAccDb.type === 'special'
      && autoAccDb.intake === 'accepted', JSON.stringify(autoAccDb));

  await push('1002', { tasks: [Object.assign({ id: AUTO, status: 'doing', intakeStatus: 'accepted' }, AUTO_T)] });
  const auto = await js(`(function(){const j=${JSON.stringify(await stateAs('1002'))};
    const t=(j.tasks||[]).find(x=>x.id==='${AUTO}'); return t?{status:t.status,intake:t.intakeStatus}:null})()`);
  check('接完之后状态才改得动（进行中不会再和「待接收」并存）',
    !!auto && auto.status === 'doing' && auto.intake !== 'pending', JSON.stringify(auto));

  const mixed = ((await stateAs('1012')) || {}).tasks || [];
  check('全量数据里没有「进行中 + 待接收」的矛盾组合',
    mixed.filter(t=>t.intakeStatus==='pending'&&t.status!=='todo').length === 0,
    JSON.stringify(mixed.filter(t=>t.intakeStatus==='pending'&&t.status!=='todo').map(t=>t.title)).slice(0, 120));

  await push('1012', { del: { tasks: [AUTO] } });
  await push('1002', { del: { tasks: [AUTO] } });


  /* ---------- 9.4 专项/临时不能指派给别人：承接人锁自己 ---------- */
  await asUser('1012');
  await nav('special'); await sleep(400);
  await js(`document.querySelector('[data-act="new"][data-type="special"]').click();'ok'`);
  await sleep(400);
  const lock1 = await js(`(function(){const w=document.querySelector('#fAssigneeWrap'); if(!w) return null;
    const tl=document.querySelector('#f_type_lock');
    return { hasSelect: !!w.querySelector('select'), locked: (w.querySelector('.locked')||{}).innerText||'',
      typeSelect: !!document.querySelector('#modal #f_type'), typeLock: (tl||{}).innerText||'' }})()`);
  check('新建专项：承接人锁成「我」，没有下拉可选',
    !!lock1 && lock1.hasSelect === false && lock1.locked.includes('我（本人）'), JSON.stringify(lock1).slice(0, 160));
  check('新建专项：类型写死为「专项任务」，弹窗里没有可改的下拉',
    !!lock1 && lock1.typeSelect === false && lock1.typeLock.includes('专项任务'), JSON.stringify(lock1).slice(0, 160));
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

  /* ---------- 9.41 类型由入口钉死：发布页只能建发布任务 ---------- */
  await nav('assign'); await sleep(500);
  await js(`document.querySelector('[data-act="new"][data-type="assign"]').click();'ok'`);
  await sleep(400);
  const lockA = await js(`(function(){const w=document.querySelector('#fAssigneeWrap');
    const tl=document.querySelector('#f_type_lock');
    return { hasSelect: !!w.querySelector('select'),
      opts: w.querySelector('select') ? w.querySelector('select').options.length : 0,
      typeSelect: !!document.querySelector('#modal #f_type'), typeLock: (tl||{}).innerText||'' }})()`);
  check('新建发布任务：类型写死为「发布任务」，弹窗里没有可改的下拉',
    !!lockA && lockA.typeSelect === false && lockA.typeLock.includes('发布任务'), JSON.stringify(lockA).slice(0, 160));
  check('新建发布任务：承接人下拉还在，能选人', !!lockA && lockA.hasSelect && lockA.opts >= 2, JSON.stringify(lockA));

  /* 不动类型直接建，落库必须是 assign——哪天有人把下拉加回来，这条会红 */
  await js(`(function(){document.querySelector('#f_title').value='E2E发布：只能是发布任务';
    const s=document.querySelector('#f_assignee'); if(s) s.value='1002';
    document.querySelector('#modal [data-act="modal-ok"]').click(); return 'ok'})()`);
  await sleep(1000);
  const madeAssign = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.filter(x=>x.title==='E2E发布：只能是发布任务').pop();
    return t?{id:t.id,type:t.type,assignee:t.assigneeNo,intake:t.intakeStatus}:null})()`);
  check('发布页建出来的就是发布任务，承接人按选的人落库',
    !!madeAssign && madeAssign.type === 'assign' && madeAssign.assignee === '1002', JSON.stringify(madeAssign));
  if (madeAssign) {
    await push('1012', { del: { tasks: [madeAssign.id] } });
    await push('1002', { del: { tasks: [madeAssign.id] } });
  }

  /* 界面之外再兜一层：直接写接口把「专项 + 别人承接」塞进去。
     服务端按承接人定类型（决策①）：承接人是别人 → 这条只能是发布任务，
     不会造出一条「挂在别人名下、我还看不见」的专项。 */
  const GUARD = 't_e2e_guard_special';
  await push('1012', { tasks: [{ id: GUARD, ownerNo: '1012', assigneeNo: '1002', type: 'special',
    title: 'E2E绕过界面塞给别人', start: '2026-11-03', end: '2026-11-06', status: 'todo' }] });
  const guard = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.find(x=>x.id==='${GUARD}');
    return t?{assignee:t.assigneeNo,type:t.type,owner:t.ownerNo,intake:t.intakeStatus}:null})()`);
  check('绕过界面写「专项 + 承接人=别人」：按承接人落成发布任务，不会冒出别人的专项',
    !!guard && guard.assignee === '1002' && guard.type === 'assign'
      && guard.owner === '1012' && guard.intake === 'pending', JSON.stringify(guard));
  await push('1012', { del: { tasks: [GUARD] } });

  /* 发布任务换承接人要真正落库（原来抽屉改完刷新就回去） */
  const SWAP = 't_e2e_swap';
  await push('1012', { tasks: [{ id: SWAP, ownerNo: '1012', assigneeNo: '1002', type: 'assign',
    title: 'E2E换承接人', start: '2026-11-03', end: '2026-11-06', status: 'todo', intakeStatus: 'pending' }] });
  await push('1012', { tasks: [{ id: SWAP, ownerNo: '1012', assigneeNo: '1003', type: 'assign',
    title: 'E2E换承接人', start: '2026-11-03', end: '2026-11-06', status: 'todo', intakeStatus: 'pending' }] });
  const swap = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.find(x=>x.id==='${SWAP}'); return t?{assignee:t.assigneeNo,intake:t.intakeStatus}:null})()`);
  check('发布任务换承接人真正落库，并重新变成待接收',
    !!swap && swap.assignee === '1003' && swap.intake === 'pending', JSON.stringify(swap));
  await push('1012', { del: { tasks: [SWAP] } });
  await push('1003', { del: { tasks: [SWAP] } });

  /* ---------- 9.45 发布自由选人 + 专项知情人 + 发布页四模块 ---------- */
  await asUser('1012');
  await nav('assign'); await sleep(500);

  /* 四个模块、顺序固定；第一块 0.7.0 起叫「我发布的任务」——这一页是发布口，不是「我的活」 */
  const blocks = await js(`[...document.querySelectorAll('#view .card-h h2')].map(h=>h.textContent.trim())`);
  check('发布页按「我发布的任务 → 下属常规 → 下属专项 → 我关注的任务」四块排',
    JSON.stringify(blocks) === JSON.stringify(['我发布的任务', '下属常规工作推进情况', '下属专项工作推进情况', '我关注的任务']),
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

  /* 只能在本人名下建任务。
     老守卫判的是「owner 不是我 且 承接人不是我」——发一条
     「owner 是别人、承接人是我」的请求就两头都不沾：守卫放行，落库的 owner 却是别人。
     结果是我能往别人名下塞一条连我自己都看不见的任务，专项「只归自己办」直接破。
     验法不能只看「有没有报错」，还要看对方名下是不是真的没多出这条。 */
  const ownGuard = await (async () => {
    /* 先清残留：上一轮要是真漏进来了，这条会一直红着，看起来像修复没生效 */
    /* 用 1004 而不是 1101：1101 在下面「知情人选没登录过的人」里必须保持未登录态，
       这里一旦以他的身份登录，那条用例就会假红（激活是登录的副作用）。 */
    await apiAs('1004', '/api/sync', { me: '1004', del: { tasks: ['e2e_owner_guard'] } });
    await apiAs('1012', '/api/sync', { me: '1012', del: { tasks: ['e2e_owner_guard'] } });
    const r = await apiAs('1012', '/api/sync', { me: '1012', tasks: [{ id: 'e2e_owner_guard', type: 'special', title: 'E2E替别人建',
      ownerNo: '1004', assigneeNo: '1012', start: '2026-11-04', end: '2026-11-06', status: 'todo', stages: [] }] });
    const j = r.json || {};
    const st = (await stateAs('1004')) || {};
    return { errors: (j.errors || []).length, rows: j.rows | 0,
      atOther: (st.tasks || []).some(t => t.id === 'e2e_owner_guard') };
  })();
  check('替别人建任务被拒：对方名下不会多出一条「我自己都看不见」的活',
    ownGuard.errors >= 1 && ownGuard.atOther === false, JSON.stringify(ownGuard));

  /* 不再要求发布人自己有直属上级。
     原来的写法是在 1012 身份下看「页面上有没有那条拦截」——可 1012 有上级（1001），
     旧版的拦截本来就不会出现，这条断言在修复前也是绿的，等于什么都没验。
     要验就得换成真的没有上级的人：1001（部门经理，mgr_no 为空）与 1101/1102 都是。 */
  await asUser('1001');
  if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
    await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(1000);
  }
  await nav('assign'); await sleep(600);
  const noMgr = await js(`(function(){
    const v=document.querySelector('#view');
    const btn=document.querySelector('[data-act="new"][data-type="assign"]');
    return {bar:!!v.querySelector('.noauth-bar'), blocked:/先设置直属上级|暂不可用/.test(v.innerText),
      hasBtn:!!btn};})()`);
  check('没有直属上级的人也能进发布页、创建按钮可用（不再要求先设上级）',
    noMgr.bar === false && noMgr.blocked === false && noMgr.hasBtn === true, JSON.stringify(noMgr));

  /* 再验一步：真的建得出来。只验「按钮在」等于只验了半条 */
  const madeByNoMgr = await js(`(async()=>{
    document.querySelector('[data-act="new"][data-type="assign"]').click();
    await new Promise(r=>setTimeout(r,450));
    const t=document.querySelector('#f_title'); if(!t) return {noForm:true};
    t.value='E2E无上级也能派';
    const s=document.querySelector('#f_start'), e=document.querySelector('#f_end');
    if(s) s.value='2026-11-04'; if(e) e.value='2026-11-06';
    document.querySelector('#modal [data-act="modal-ok"]').click();
    await new Promise(r=>setTimeout(r,900));
    const st=await (await fetch('/api/state?me=1001')).json();
    const row=(st.tasks||[]).find(x=>x.title==='E2E无上级也能派');
    return {created:!!row, owner:row&&row.ownerNo, blocked:/先设置直属上级/.test(document.body.innerText)};})()`);
  check('没有上级的人点创建真的能落地一条任务',
    madeByNoMgr.created === true && madeByNoMgr.owner === '1001' && madeByNoMgr.blocked === false,
    JSON.stringify(madeByNoMgr));
  await js(`(async()=>{const st=await (await fetch('/api/state?me=1001')).json();
    const row=(st.tasks||[]).find(x=>x.title==='E2E无上级也能派');
    if(row) await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({me:'1001',del:{tasks:[row.id]}})});
    return 'ok'})()`);

  /* 切回 1012 继续后面的用例 */
  await asUser('1012');
  if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
    await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(1000);
  }
  await nav('assign'); await sleep(500);

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

  /* 只改标题时，提交体里到底带不带 observers？
     这一条必须走**页面自己的保存路径**（`persist()`），不能直接 fetch：
     原来那条「另一个标签页只改标题、没带名单」是手写的请求体，本来就不带 observers，
     所以它在修复前也是绿的——只证明了服务端「没提交 ≠ 清空」，没证明前端不再把旧名单捎上去。
     这里拦住 window.fetch，让用户只改标题，看真正发出去的那份 body 里有没有 observers。 */
  if (obsSaved) {
    await js(`openTaskPage(${JSON.stringify(obsSaved.id)});'ok'`); await sleep(500);
    const capBody = await js(`(async()=>{
      const orig=window.fetch, seen=[];
      window.fetch=function(u,o){ try{ if(String(u).includes('/api/sync')&&o&&o.body) seen.push(JSON.parse(o.body)); }catch(e){}
        return orig.apply(this,arguments); };
      const inp=document.querySelector('#dTitle');
      if(!inp) { window.fetch=orig; return {noInput:true}; }
      inp.value=${JSON.stringify(OBS_TASK + '（改名）')};
      inp.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,1200));
      window.fetch=orig;
      const hit=seen.find(b=>(b.tasks||[]).some(t=>t.id===${JSON.stringify(obsSaved.id)}));
      const row=hit&&hit.tasks.find(t=>t.id===${JSON.stringify(obsSaved.id)});
      const st=await (await fetch('/api/state?me=1012')).json();
      const t=st.tasks.find(x=>x.id===${JSON.stringify(obsSaved.id)});
      return {sent:!!row, hasObservers:!!(row&&'observers' in row),
        title:t&&t.title, observers:(t&&t.observers)||[]};})()`);
    check('只改标题时，提交的那一份 body 里不带 observers（旧副本不会把名单写回去）',
      capBody.sent === true && capBody.hasObservers === false
        && capBody.title === OBS_TASK + '（改名）' && capBody.observers.includes('1101'),
      JSON.stringify(capBody).slice(0, 240));
    await js(`document.querySelector('.td-head [data-act="close"]').click();'ok'`);
    await sleep(300);
    /* 名字改回来了，后面按原标题找这条 */
    await js(`(async()=>{await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({me:'1012',tasks:[{id:${JSON.stringify(obsSaved.id)},type:'special',
        title:${JSON.stringify(OBS_TASK)},ownerNo:'1012',assigneeNo:'1012',
        start:'2026-11-03',end:'2026-11-30',status:'doing',stages:[]}]})});return 'ok'})()`);
  }

  /* 知情人视角：能在「我关注的任务」里看到这条，且只有查看权 */
  if (obsSaved) {
    await asUser('1101');
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

    /* 名单本身也是信息：知道「还有谁在知情」等于知道谁在被观察。
       只验「没有删按钮」不够——接口要是把名单回给知情人，页面照样能渲染出姓名。 */
    const obsLeak = await js(`(async()=>{
      const st=await (await fetch('/api/state?me=1101')).json();
      const t=st.tasks.find(x=>x.id===${JSON.stringify(obsSaved.id)});
      return {observers:(t&&t.observers)||[], flagged:!!(t&&t.observer),
        pageHasObsCard:!!document.querySelector('#view [data-act="obs-del"]')};})()`);
    check('知情人拿不到名单：接口回给他的 observers 是空的，页面上也没有知情人人名',
      Array.isArray(obsLeak.observers) && obsLeak.observers.length === 0
        && obsLeak.flagged === true && obsLeak.pageHasObsCard === false,
      JSON.stringify(obsLeak));
    await js(`document.querySelector('.td-head [data-act="close"]').click();'ok'`);
    await sleep(300);

    /* 界面不给按钮只是一半，真正的边界在服务端。
       少了这条，「知情人只读」就只证明了「没做按钮」——把 server.js 的归属校验删掉照样全绿。 */
    const obsWrite = await js(`(async()=>{
      const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({me:'1101',tasks:[{id:${JSON.stringify(obsSaved.id)},type:'special',
          title:'知情人改的标题',ownerNo:'1012',assigneeNo:'1012',
          start:'2026-11-03',end:'2026-11-30',status:'done',stages:[]}]})});
      const j=await r.json();
      return {rows:j.rows|0,errors:(j.errors||[]).length};})()`);
    /* 页面这时是 1101 的身份，读 1012 的事实必须换身份读，`?me=1012` 会被 403 挡住。 */
    const obsWriteDb = ((await stateAs('1012')).tasks || []).find((x) => x.id === obsSaved.id) || {};
    obsWrite.title = obsWriteDb.title;
    obsWrite.status = obsWriteDb.status;
    /* 只看「状态没变」不够：任何原因写不进去都会让状态不变。
       必须同时看到 rows=0 且有 errors——那才证明是归属校验挡的，而不是别的地方碰巧失败。 */
    check('知情人绕开界面直接提交：服务端明确拒收，标题和状态一个字没变',
      obsWrite.rows === 0 && obsWrite.errors >= 1
        && obsWrite.title === OBS_TASK && obsWrite.status !== 'done', JSON.stringify(obsWrite));

    /* 服务端语义：请求体里没有这条任务/没有这个字段 ≠ 清空名单。
       注意这条**不测前端**——它手写的 body 本来就不带 observers，修复前后都绿；
       前端那半条在上面「只改标题时提交体里不带 observers」里验。 */
    const keepObs = await (async () => {
      await apiAs('1012', '/api/sync', { me: '1012', tasks: [{ id: obsSaved.id, type: 'special',
        title: OBS_TASK, ownerNo: '1012', assigneeNo: '1012',
        start: '2026-11-03', end: '2026-11-30', status: 'doing', stages: [] }] });
      const j = (await stateAs('1012')) || {};
      const t = (j.tasks || []).find(x => x.id === obsSaved.id);
      return { observers: (t && t.observers) || [], status: t && t.status };
    })();
    check('服务端：请求里没带 observers 就原样保留，不当成清空',
      keepObs.observers.includes('1101') && keepObs.status === 'doing', JSON.stringify(keepObs));

    /* 跨级发布的闭环：派给非直接下属，对方接收后所有权转到他身上，发布人还得看得到。
       0.6.3 是靠「承接时另建一条 source_id 指回来的副本」解决的，0.7.0 改成所有权转移，
       副本那条链路退役——但「派给非下属之后不能断线」这条不变量必须继续成立。
       可见性现在靠 publisher_no：这条任务的 owner 是 1101（不在我的直接下属里），
       只有发布人这一条路径能把它捡回来，所以这条用例专门走跨级（1012 → 1101）。 */
    const cross = await (async () => {
      const mk = (await apiAs('1012', '/api/sync', { me: '1012', tasks: [{ id: 'e2e_cross_src', type: 'assign', title: 'E2E跨级发布源',
        ownerNo: '1012', assigneeNo: '1101', start: '2026-11-03', end: '2026-11-10', status: 'todo',
        intakeStatus: 'pending', stages: [] }] })).json || {};
      const acc = (await apiAs('1101', '/api/task/accept', { me: '1101', id: 'e2e_cross_src' })).json || {};
      /* 承接人接着往自己那边拆阶段，发布人看到的进度要跟着走 */
      const plan = (await apiAs('1101', '/api/sync', { me: '1101', tasks: [{ id: 'e2e_cross_src', type: 'special', title: 'E2E跨级发布源',
        ownerNo: '1101', assigneeNo: '1101', start: '2026-11-03', end: '2026-11-10', status: 'doing',
        stages: [{ id: 'cs1', pid: null, name: '跨级第一段', start: '2026-11-03', end: '2026-11-10', done: false }] }] })).json || {};
      const st = (await stateAs('1012')) || {};
      const row = (st.tasks || []).find(x => x.id === 'e2e_cross_src');
      return { mkErr: (mk.errors || []).length, accOk: !!acc.ok, planErr: (plan.errors || []).length,
        isSub: (st.subs || []).some(s => s.no === '1101'),
        visible: !!row, owner: row && row.ownerNo, pub: row && row.publisherNo, type: row && row.type,
        stages: row && row.stages ? row.stages.length : 0 };
    })();
    check('跨级发布：非下属接收后所有权转给他，发布人照样看得到进度（断线的那条不变量）',
      cross.mkErr === 0 && cross.accOk === true && cross.planErr === 0 && cross.isSub === false
        && cross.visible === true && cross.owner === '1101' && cross.pub === '1012'
        && cross.type === 'special' && cross.stages === 1,
      JSON.stringify(cross));
    /* 清理也走 Node 侧：页面是 1101 的身份，带 me:1012 的页内请求会被会话门 403 挡掉，
       于是「删掉 1012 那条」根本没发生，下一轮就跑在脏数据上。 */
    await push('1101', { del: { tasks: ['e2e_cross_src'] } });
    await push('1012', { del: { tasks: ['e2e_cross_src'] } });

    await push('1012', { del: { tasks: [obsSaved.id] } });
  }

  /* ---------- 9.9 阶段派发 → 子专项：接收前不生效，一条活只出现一次 ----------
     旧链路是「派发只打时间戳 → 责任人加入待办 → 生成只读副本」，一段活在两处出现，
     完成态还有两条通道。新链路：派发落地成一条 pending 子专项，对方接收后才是独立专项；
     父阶段自己不存完成态，只读子专项汇总。 */
  {
    const FLOW = 't_e2e_flow';
    const SUBW = '1003';
    const OTHERW = '1004';
    const LATER = '1005';
    const childId = sid => 'nt_' + FLOW + '_' + sid;
    const d = n => addDaysStr('2026-11-10', n);
    const whoAmI = async no => {
      await asUser(no);
      if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
        await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(800);
      }
    };
    await push('1012', { del: { tasks: [FLOW] } });
    await push('1002', { del: { tasks: [FLOW, childId('f2'), childId('f3')] } });
    for (const no of [SUBW, OTHERW, LATER]) await push(no, { del: { tasks: [childId('f2'), childId('f3')] } });
    /* 提醒不随任务删除而消失（墓碑就是设计成这样），开跑前先把这几个人的旧提醒读完 */
    for (const no of [SUBW, OTHERW, LATER, '1002']) {
      const j = (await stateAs(no)) || {};
      const ids = (j.notices || []).filter(n => [FLOW, childId('f2'), childId('f3')].includes(n.taskId)).map(n => n.id);
      if (ids.length) await apiAs(no, '/api/notice/seen', { me: no, ids });
    }
    await pushJ('1012', { tasks: [{ id: FLOW, type: 'assign', title: 'E2E发布：分给两个人干',
      ownerNo: '1012', assigneeNo: '1002', start: d(0), end: d(6), status: 'todo', intakeStatus: 'pending',
      stages: [
        { id: 'f1', pid: null, name: '整段', start: d(0), end: d(6), done: false },
        { id: 'f2', pid: 'f1', name: '前半段', who: SUBW, start: d(0), end: d(2), done: false },
        { id: 'f3', pid: 'f1', name: '后半段', who: OTHERW, start: d(3), end: d(6), done: false }
      ] }] });

    /* 只指定、没派发 = 对他等于没这回事。 */
    const preWho = (await (async () => {
      const j = (await stateAs(SUBW)) || {};
      return { has: (j.tasks || []).some(t => t.id === FLOW), notices: (j.notices || []).filter(n => n.taskId === FLOW).length };
    })());
    check('只指定了责任人、还没派发：他那边连这条任务都看不到',
      preWho.has === false && preWho.notices === 0, JSON.stringify(preWho));

    await whoAmI('1002');
    await nav('intake'); await sleep(500);
    const intakeUi = await js(`(function(){
      const cards=[...document.querySelectorAll('#view .card')];
      const pick=t=>cards.find(c=>c.textContent.includes(t));
      const a=pick('等你立项的任务'), b=pick('分给你的子任务');
      return {pending:a?[...a.querySelectorAll('.rule-card h2')].map(x=>x.textContent.trim()):[],
        subs:b?[...b.querySelectorAll('.rule-card h2')].map(x=>x.textContent.trim()):[],
        acceptBtn:!!document.querySelector('#view [data-act="intake-accept"]')};})()`);
    check('承接台：发布出去还没接的活落在「等你立项」，带一个「接收」按钮',
      intakeUi.pending.includes('E2E发布：分给两个人干') && intakeUi.acceptBtn === true,
      JSON.stringify(intakeUi).slice(0, 220));
    check('承接台：派发之前「分给你的子任务」是空的（指定 ≠ 派发）',
      intakeUi.subs.length === 0, JSON.stringify(intakeUi.subs));

    await js(`document.querySelector('#view [data-act="intake-accept"][data-id="${FLOW}"]').click();'ok'`);
    await sleep(1300);
    const afterAcc = await js(`(async()=>{const j=await (await fetch('/api/state?me=1002')).json();
      const t=(j.tasks||[]).find(x=>x.id==='${FLOW}');
      const same=(j.tasks||[]).filter(x=>x.id==='${FLOW}').length;
      return {owner:t&&t.ownerNo,type:t&&t.type,intake:t&&t.intakeStatus,rows:same};})()`);
    check('点「接收」：活转到自己名下、进专项工作，没有多出第二条任务',
      afterAcc.owner === '1002' && afterAcc.type === 'special'
        && afterAcc.intake === 'accepted' && afterAcc.rows === 1, JSON.stringify(afterAcc));

    await js(`openTaskPage('${FLOW}');'ok'`); await sleep(700);
    const dispatchUi = await js(`(function(){
      const ti=document.querySelector('#dTitle');
      return {canEdit:!!ti && ti.readOnly === false,
        hasBtn:!!document.querySelector('#view [data-act="task-dispatch"]')};})()`);
    check('接收之后这条归「我」编辑：详情页出现「有子任务还没派发」的提示和派发按钮',
      dispatchUi.canEdit === true && dispatchUi.hasBtn === true, JSON.stringify(dispatchUi));
    await js(`document.querySelector('#view [data-act="task-dispatch"]').click();'ok'`);
    await sleep(1400);

    /* 派发落地成两条 pending 子专项：不再是「只写 whoAt、等他加入待办」 */
    const dbC2 = dbGet('SELECT * FROM task WHERE id=?', childId('f2'));
    const dbC3 = dbGet('SELECT * FROM task WHERE id=?', childId('f3'));
    check('派发落地：一段一条 pending 子专项，带父任务/父阶段引用，不写 stage_ref',
      !!dbC2 && !!dbC3 && dbC2.type === 'assign' && dbC2.owner_no === '1002' && dbC2.assignee_no === SUBW
        && dbC2.intake_status === 'pending' && dbC2.parent_task_id === FLOW && dbC2.parent_stage_id === 'f2'
        && !dbC2.stage_ref && dbC3.parent_stage_id === 'f3',
      JSON.stringify([dbC2, dbC3].map(c => c && [c.id, c.type, c.owner_no, c.assignee_no, c.intake_status, c.parent_task_id, c.parent_stage_id])));
    const dbParent = JSON.parse((dbGet('SELECT stages FROM task WHERE id=?', FLOW) || {}).stages || '[]');
    const dbF2 = dbParent.find(s => s.id === 'f2') || {};
    check('派发后父阶段的责任人清空、完成态不落库（否则同一条活会有两处负责与两处完成）',
      !dbF2.who && !dbF2.whoAt && dbF2.done === false, JSON.stringify(dbF2));

    const dis = await stateAs('1002');
    const pFlow = (dis.tasks || []).find(t => t.id === FLOW) || {};
    const pF2 = (pFlow.stages || []).find(s => s.id === 'f2') || {};
    check('派发人自己的列表里没有这条子专项：同一条活不会出现两次',
      !(dis.tasks || []).some(t => t.id === childId('f2')), '可见任务 ' + (dis.tasks || []).length);
    check('父阶段挂的是摘要：待接收 + 进度 0，且不含子任务的 stages',
      !!pF2.child && pF2.child.intakeStatus === 'pending' && pF2.child.progress === 0 && !('stages' in pF2.child),
      JSON.stringify(pF2.child));

    const rec = await stateAs(SUBW);
    const recC2 = (rec.tasks || []).find(t => t.id === childId('f2')) || {};
    check('责任人那边只多出这一条子专项，看不到父任务本身',
      recC2.intakeStatus === 'pending' && !(rec.tasks || []).some(t => t.id === FLOW),
      JSON.stringify({ id: recC2.id, intake: recC2.intakeStatus, hasParent: (rec.tasks || []).some(t => t.id === FLOW) }));

    /* 接收前不进对方日历：pending assign 被 isMineTask 排除，日历里不该出现 */
    await whoAmI(SUBW);
    await nav('calendar'); await sleep(700);
    const calHas = await js(`document.querySelector('#view').innerText.includes('前半段')`);
    check('接收前不进他的日历', calHas === false, '日历里出现了前半段=' + calHas);

    await nav('intake'); await sleep(600);
    const subIntake = await js(`(function(){
      const cards=[...document.querySelectorAll('#view .card')];
      const pick=t=>cards.find(c=>c.textContent.includes(t));
      const a=pick('等你立项的任务'), b=pick('分给你的子任务');
      return {pending:a?[...a.querySelectorAll('.rule-card h2')].map(x=>x.textContent.trim()):[],
        subs:b?[...b.querySelectorAll('.rule-card h2')].map(x=>x.textContent.trim()):[],
        accept:!!document.querySelector('#view [data-act="intake-accept"][data-id="${childId('f2')}"]')};})()`);
    check('承接台：子专项落在「等你立项」，不是旧的「分给你的子任务」',
      subIntake.pending.some(s => s.includes('前半段')) && subIntake.subs.length === 0 && subIntake.accept === true,
      JSON.stringify(subIntake).slice(0, 240));

    /* 改派：待接收时换人，仍是同一条子专项，不产生第二条 */
    const re = await act('/api/task/dispatch', { me: '1002', id: FLOW, stageId: 'f3', who: LATER });
    const reRow = dbGet('SELECT * FROM task WHERE parent_task_id=? AND parent_stage_id=?', FLOW, 'f3');
    check('改派：只换承接人，子专项还是同一条',
      re.ok === true && re.reassigned === true && reRow && reRow.assignee_no === LATER
        && dbGet('SELECT COUNT(*) c FROM task WHERE parent_task_id=? AND parent_stage_id=?', FLOW, 'f3').c === 1,
      JSON.stringify({ re, assignee: reRow && reRow.assignee_no }));
    const stL = await stateAs(LATER);
    const stO = await stateAs(OTHERW);
    check('改派之后新承接人看得到、原承接人看不到了',
      (stL.tasks || []).some(t => t.id === childId('f3')) && !(stO.tasks || []).some(t => t.id === childId('f3')),
      JSON.stringify({ later: (stL.tasks || []).some(t => t.id === childId('f3')), other: (stO.tasks || []).some(t => t.id === childId('f3')) }));

    /* 界面上的撤回：待接收那一段给「撤回」，点完这一段回到未派发 */
    await whoAmI('1002');
    await js(`openTaskPage('${FLOW}');'ok'`); await sleep(700);
    const pendingRow = await js(`(function(){
      const rows=[...document.querySelectorAll('#view .stage.sub')];
      const r=rows.find(x=>x.textContent.includes('后半段'));
      return {undo:!!(r&&r.querySelector('[data-act="stage-undispatch"]')),
        reassign:!!(r&&r.querySelector('[data-act="stage-redispatch"]')),
        tag:(r&&r.querySelector('.subtag')?r.querySelector('.subtag').innerText:''),
        whoSel:!!(r&&r.querySelector('[data-act="stage-who"]'))};})()`);
    check('待接收那一段：给「撤回」和「改派」，不再出现「谁做」下拉',
      pendingRow.undo === true && pendingRow.reassign === true && pendingRow.tag.includes('待接收') && pendingRow.whoSel === false,
      JSON.stringify(pendingRow));
    await js(`window.confirm=()=>true;'ok'`);
    await js(`document.querySelector('#view [data-act="stage-undispatch"][data-sid="f3"]').click();'ok'`);
    await sleep(1400);
    const afterUndo = dbGet('SELECT * FROM task WHERE parent_task_id=? AND parent_stage_id=?', FLOW, 'f3');
    const undoParent = JSON.parse((dbGet('SELECT stages FROM task WHERE id=?', FLOW) || {}).stages || '[]');
    const undoF3 = undoParent.find(s => s.id === 'f3') || {};
    check('撤回：pending 子专项被收走，父阶段回到「已指定、未派发」，可以再派',
      !afterUndo && undoF3.who === LATER && !undoF3.whoAt && !undoF3.done, JSON.stringify(undoF3));
    const stL2 = await stateAs(LATER);
    check('撤回后对方那边这条也没了', !(stL2.tasks || []).some(t => t.id === childId('f3')));

    /* 接收 f2 的子专项：从承接台点「接收」 */
    await whoAmI(SUBW);
    await nav('intake'); await sleep(600);
    await js(`document.querySelector('#view [data-act="intake-accept"][data-id="${childId('f2')}"]').click();'ok'`);
    await sleep(1400);
    const accC2 = dbGet('SELECT * FROM task WHERE id=?', childId('f2'));
    check('接收：pending 子任务变成自己名下的专项，父引用保留',
      accC2.type === 'special' && accC2.owner_no === SUBW && accC2.intake_status === 'accepted'
        && accC2.parent_task_id === FLOW && accC2.parent_stage_id === 'f2',
      JSON.stringify([accC2.type, accC2.owner_no, accC2.intake_status, accC2.parent_task_id, accC2.parent_stage_id]));
    const pAfterAcc = ((await stateAs('1002')).tasks || []).find(t => t.id === FLOW) || {};
    const pAfterF2 = (pAfterAcc.stages || []).find(s => s.id === 'f2') || {};
    check('父阶段摘要跟着变：已接收、待开展、进度 0',
      pAfterF2.child && pAfterF2.child.intakeStatus === 'accepted' && pAfterF2.child.status === 'todo' && pAfterF2.child.progress === 0,
      JSON.stringify(pAfterF2.child));

    /* 子专项是独立专项，不是只读副本 */
    await js(`openTaskPage('${childId('f2')}');'ok'`); await sleep(700);
    const childUi = await js(`(function(){
      const ti=document.querySelector('#dTitle');
      return {editable:!!ti&&ti.readOnly===false,
        del:!!document.querySelector('#view [data-act="task-del"]'),
        src:(document.querySelector('#view').innerText||'').includes('来自「E2E发布：分给两个人干」')};})()`);
    check('子专项是独立专项：标题可改、能自己删，详情写明来自哪一段',
      childUi.editable === true && childUi.del === true && childUi.src === true, JSON.stringify(childUi));

    /* 父方改自己那一段的日期，不会偷偷改掉子专项的计划 */
    await pushJ('1002', { tasks: [{ id: FLOW, ownerNo: '1002', assigneeNo: '1002', type: 'special',
      title: 'E2E发布：分给两个人干', start: d(0), end: d(6), status: 'todo',
      stages: [
        { id: 'f1', pid: null, name: '整段', start: d(0), end: d(6), done: false },
        { id: 'f2', pid: 'f1', name: '前半段', start: d(0), end: d(1), done: false },
        { id: 'f3', pid: 'f1', name: '后半段', who: LATER, start: d(3), end: d(6), done: false }
      ] }] });
    const childPlan = dbGet('SELECT start_date,end_date FROM task WHERE id=?', childId('f2'));
    check('父方改那一段的日期只动父任务的排期，子专项自己的计划不被覆盖',
      childPlan.start_date === d(0) && childPlan.end_date === d(2), JSON.stringify(childPlan));

    const lateRe = await act('/api/task/dispatch', { me: '1002', id: FLOW, stageId: 'f2', who: OTHERW });
    check('已接收的子专项不能再改派（本轮明确不做，接口要给可读原因）',
      lateRe.ok === false && /接收/.test(lateRe.msg || ''), JSON.stringify(lateRe));
    const lateUndo = await act('/api/task/undispatch', { me: '1002', id: FLOW, stageId: 'f2' });
    check('已接收的子专项不能撤回',
      lateUndo.ok === false && /接收/.test(lateUndo.msg || ''), JSON.stringify(lateUndo));

    /* 清理：子专项归 1003，父任务归 1002，各自删各自的 */
    await push(SUBW, { del: { tasks: [childId('f2')] } });
    await push('1002', { del: { tasks: [FLOW] } });
    await push('1012', { del: { tasks: [FLOW] } });
    for (const no of [SUBW, OTHERW, LATER, '1002']) await act('/api/notice/seen', { me: no });

    /* ---------- 9.9b 一级阶段行直接设责任人（0.12.0）----------
       验收反馈：只有一级阶段的专项没有任何派发入口，必须先「+ 子任务 → 填名 → 选人 →
       派发」四步；入口本身也看不见。这里从 DOM 拨那个下拉，验证「一步生成同名同窗
       二级子阶段 + 立刻派成待接收」；再绕过界面直调，验服务端拒绝点。
       夹具故意让一级阶段没有 id：演示数据里就有 5 条这种任务，补 id 的逻辑必须真的跑。 */
    const TOPW = 't_e2e_topwho';
    const TOPWT = 't_e2e_topwho_temp';
    await push('1012', { del: { tasks: [TOPW, TOPWT] } });
    await pushJ('1012', { tasks: [{
      id: TOPW, type: 'special', title: 'E2E一级行派发', ownerNo: '1012', assigneeNo: '1012',
      start: d(0), end: d(6), dueDate: d(6), status: 'todo',
      stages: [
        { name: '整段交给同事', start: d(0), end: d(2) },
        { id: 'tw2', pid: null, name: '自己留着做', start: d(3), end: d(4), done: false },
        { id: 'tw3', pid: null, name: '已完成段', start: d(5), end: d(6), done: true }
      ]
    }] });
    await whoAmI('1012');
    await js(`openTaskPage('${TOPW}');'ok'`); await sleep(800);

    const topEntry = await js(`(function(){
      const rows=[...document.querySelectorAll('#view .stage:not(.sub)')];
      const r=rows.find(x=>x.textContent.includes('整段交给同事'));
      const sel=r&&r.querySelector('[data-act="stage-who-top"]');
      return {rows:rows.length, hasSel:!!sel, label:(r?r.innerText:'').includes('谁做'),
        opts:sel?sel.querySelectorAll('option').length:0};})()`);
    check('一级阶段行直接出现「谁做」：带可见标签，不是只能悬停猜',
      topEntry.rows === 3 && topEntry.hasSel === true && topEntry.label === true && topEntry.opts >= 2,
      JSON.stringify(topEntry));

    const topPick = await js(`(async()=>{
      const rows=[...document.querySelectorAll('#view .stage:not(.sub)')];
      const r=rows.find(x=>x.textContent.includes('整段交给同事'));
      const sel=r.querySelector('[data-act="stage-who-top"]');
      sel.value='1003';
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,1800));
      const j=await (await fetch('/api/state?me=1012')).json();
      const t=(j.tasks||[]).find(x=>x.id==='${TOPW}');
      const top=(t&&t.stages||[]).find(s=>!s.pid && s.name==='整段交给同事');
      const kid=(t&&t.stages||[]).find(s=>s.pid && top && s.pid===top.id);
      const rowNow=[...document.querySelectorAll('#view .stage:not(.sub)')].find(x=>x.textContent.includes('整段交给同事'));
      const subRow=[...document.querySelectorAll('#view .stage.sub')].find(x=>x.textContent.includes('整段交给同事'));
      return {topId:top&&top.id, topWho:top&&top.who, topStart:top&&top.start, topEnd:top&&top.end,
        kid:kid&&{id:kid.id,pid:kid.pid,name:kid.name,start:kid.start,end:kid.end,who:kid.who,
          intake:kid.child&&kid.child.intakeStatus,assignee:kid.child&&kid.child.assigneeNo},
        topSelNow:!!(rowNow&&rowNow.querySelector('[data-act="stage-who-top"]')),
        subTag:subRow?((subRow.querySelector('.subtag')||{}).innerText||''):'',
        subUndo:!!(subRow&&subRow.querySelector('[data-act="stage-undispatch"]')),
        subReassign:!!(subRow&&subRow.querySelector('[data-act="stage-redispatch"]'))};})()`);
    check('一级阶段行选人 = 一步生成同名、同起止的二级子阶段并派成待接收',
      !!topPick.kid && topPick.kid.pid === topPick.topId && topPick.kid.name === '整段交给同事'
        && topPick.kid.start === topPick.topStart && topPick.kid.end === topPick.topEnd
        && topPick.kid.intake === 'pending' && topPick.kid.assignee === '1003',
      JSON.stringify(topPick).slice(0, 320));
    check('一级阶段本身不存 who：责任在派出去的二级节点/子专项上',
      topPick.topWho === null || topPick.topWho === undefined, 'topWho=' + topPick.topWho);
    check('派完一级行收起「谁做」，二级行显示待接收并给撤回/改派（两个入口不并存）',
      topPick.topSelNow === false && topPick.subTag.includes('待接收')
        && topPick.subUndo === true && topPick.subReassign === true,
      JSON.stringify({ sel: topPick.topSelNow, tag: topPick.subTag, undo: topPick.subUndo, re: topPick.subReassign }));

    const dbTopStages = JSON.parse((dbGet('SELECT stages FROM task WHERE id=?', TOPW) || {}).stages || '[]');
    const dbTopNode = dbTopStages.find(s => !s.pid && s.name === '整段交给同事') || {};
    const dbKidNode = dbTopStages.find(s => s.pid && s.pid === dbTopNode.id) || {};
    const dbTopChild = dbGet('SELECT * FROM task WHERE parent_task_id=? AND parent_stage_id=?', TOPW, dbKidNode.id);
    check('老数据一级阶段缺 id：派发时补上，并让子专项的父阶段引用指向它',
      !!dbTopNode.id && !!dbKidNode.id && dbKidNode.pid === dbTopNode.id && !!dbTopChild,
      JSON.stringify({ topId: dbTopNode.id, kidPid: dbKidNode.pid, child: dbTopChild && dbTopChild.id }));
    check('服务端落地：pending 子专项带父引用、不写 stage_ref，节点的 who 已清空',
      !!dbTopChild && dbTopChild.type === 'assign' && dbTopChild.intake_status === 'pending'
        && dbTopChild.assignee_no === '1003' && !dbTopChild.stage_ref
        && dbKidNode.who === null && dbKidNode.whoAt === null,
      JSON.stringify(dbTopChild && [dbTopChild.type, dbTopChild.intake_status, dbTopChild.assignee_no, dbTopChild.stage_ref, dbKidNode.who]));

    /* 直调接口的反向路径：入口只在一级行，服务端也要逐条拒。 */
    const reKids = await act('/api/task/dispatch', { me: '1012', id: TOPW, topStageId: dbTopNode.id, who: '1004' });
    check('反向：一级阶段已经拆过，再走一级入口被拒（不产生第二条）',
      reKids.ok === false && /子任务/.test(reKids.msg || '')
        && dbGet('SELECT COUNT(*) c FROM task WHERE parent_task_id=? AND parent_stage_id=?', TOPW, dbKidNode.id).c === 1,
      JSON.stringify(reKids));
    const reChild = await act('/api/task/dispatch', { me: '1012', id: TOPW, topStageId: dbKidNode.id, who: '1004' });
    check('反向：入口只给一级阶段，指到二级阶段被拒', reChild.ok === false && /一级阶段/.test(reChild.msg || ''), JSON.stringify(reChild));
    const reNoWho = await act('/api/task/dispatch', { me: '1012', id: TOPW, topStageId: 'tw2', who: '' });
    check('反向：一级入口不选人直接调用被拒', reNoWho.ok === false && /选一个人/.test(reNoWho.msg || ''), JSON.stringify(reNoWho));
    const reNotOwner = await act('/api/task/dispatch', { me: '1003', id: TOPW, topStageId: 'tw2', who: '1004' });
    check('反向：非承接人不能借一级入口派发', reNotOwner.ok === false && /承接人/.test(reNotOwner.msg || ''), JSON.stringify(reNotOwner));
    const reGhost = await act('/api/task/dispatch', { me: '1012', id: TOPW, topStageId: 'tw2', who: '000000' });
    check('反向：花名册外的人不能被派', reGhost.ok === false && /花名册/.test(reGhost.msg || ''), JSON.stringify(reGhost));
    const reDone = await act('/api/task/dispatch', { me: '1012', id: TOPW, topStageId: 'tw3', who: '1003' });
    check('反向：已完成的一级阶段不能再交给别人（先把完成取消）',
      reDone.ok === false && /已经完成/.test(reDone.msg || ''), JSON.stringify(reDone));

    /* 撤回：一级行「谁做」生成的自动段要连同节点一起收掉，一级入口自动回来。
       只把 who 还原、空段留在原地的话，一级行会永久收起，只能靠「+ 子任务」绕。 */
    await js(`window.confirm=()=>true;'ok'`);
    const undoUi = await js(`(async()=>{
      const subRow=[...document.querySelectorAll('#view .stage.sub')].find(x=>x.textContent.includes('整段交给同事'));
      const btn=subRow&&subRow.querySelector('[data-act="stage-undispatch"]');
      if(!btn) return {clicked:false};
      btn.click();
      await new Promise(r=>setTimeout(r,1800));
      const j=await (await fetch('/api/state?me=1012')).json();
      const t=(j.tasks||[]).find(x=>x.id==='${TOPW}');
      const kids=((t&&t.stages)||[]).filter(s=>s.pid);
      const row=[...document.querySelectorAll('#view .stage:not(.sub)')].find(x=>x.textContent.includes('整段交给同事'));
      const sel=row&&row.querySelector('[data-act="stage-who-top"]');
      return {clicked:true,kids:kids.length,autoLeft:kids.some(k=>k.auto),topSel:!!sel,
        opts:sel?sel.querySelectorAll('option').length:0};})()`);
    check('撤回后：自动生成的二级段被收掉，一级行「谁做」自动回来（不卡死）',
      undoUi.clicked === true && undoUi.kids === 0 && undoUi.autoLeft === false
        && undoUi.topSel === true && undoUi.opts >= 2, JSON.stringify(undoUi));
    const undoStages1 = JSON.parse((dbGet('SELECT stages FROM task WHERE id=?', TOPW) || {}).stages || '[]');
    check('撤回后服务端状态：自动段与 pending 子专项都已删除',
      !undoStages1.some(s => s.auto) && !dbGet('SELECT id FROM task WHERE parent_task_id=?', TOPW),
      JSON.stringify(undoStages1));

    /* 撤回后再派同一人：一级入口还在，能立刻再派；派完又收起。 */
    const againSame = await js(`(async()=>{
      const row=[...document.querySelectorAll('#view .stage:not(.sub)')].find(x=>x.textContent.includes('整段交给同事'));
      const sel=row&&row.querySelector('[data-act="stage-who-top"]');
      if(!sel) return {hasSel:false};
      sel.value='1003';
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,1800));
      const j=await (await fetch('/api/state?me=1012')).json();
      const t=(j.tasks||[]).find(x=>x.id==='${TOPW}');
      const kids=((t&&t.stages)||[]).filter(s=>s.pid);
      const row2=[...document.querySelectorAll('#view .stage:not(.sub)')].find(x=>x.textContent.includes('整段交给同事'));
      return {hasSel:true,kids:kids.length,assignee:kids[0]&&kids[0].child&&kids[0].child.assigneeNo,
        selGone:!(row2&&row2.querySelector('[data-act="stage-who-top"]'))};})()`);
    check('撤回后再派同一人：成功，一级入口再次收起',
      againSame.hasSel === true && againSame.kids === 1 && againSame.assignee === '1003' && againSame.selGone === true,
      JSON.stringify(againSame));

    const againStages = JSON.parse((dbGet('SELECT stages FROM task WHERE id=?', TOPW) || {}).stages || '[]');
    const againNode = againStages.find(s => s.auto) || {};
    const undo2 = await act('/api/task/undispatch', { me: '1012', id: TOPW, stageId: againNode.id });
    check('第二次撤回：自动段再次收掉，一个不留',
      undo2.ok === true && !dbGet('SELECT id FROM task WHERE parent_task_id=?', TOPW)
        && !JSON.parse((dbGet('SELECT stages FROM task WHERE id=?', TOPW) || {}).stages || '[]').some(s => s.pid),
      JSON.stringify(undo2));

    /* 换另一人再派：一级入口同样可用；拿已经收掉的自动段 id 再派要被拒。 */
    const topAfter = JSON.parse((dbGet('SELECT stages FROM task WHERE id=?', TOPW) || {}).stages || '[]')
      .find(s => !s.pid && s.name === '整段交给同事') || {};
    const otherWho = await act('/api/task/dispatch', { me: '1012', id: TOPW, topStageId: topAfter.id, who: '1004' });
    const otherChild = dbGet('SELECT * FROM task WHERE parent_task_id=?', TOPW);
    check('撤回后换另一人：一级入口仍可派',
      otherWho.ok === true && otherWho.n === 1 && !!otherChild && otherChild.assignee_no === '1004'
        && otherChild.intake_status === 'pending', JSON.stringify(otherWho));
    const stale = await act('/api/task/dispatch', { me: '1012', id: TOPW, topStageId: againNode.id, who: '1003' });
    check('反例：撤回后拿已收掉的自动段 id 再派，服务端拒（找不到这一段）',
      stale.ok === false && /找不到这一段/.test(stale.msg || ''), JSON.stringify(stale));

    /* 临时任务即使有阶段也不允许走这条路（服务端拒，界面也不给入口）。 */
    await pushJ('1012', { tasks: [{
      id: TOPWT, type: 'temp', title: 'E2E临时不拆段', ownerNo: '1012', assigneeNo: '1012',
      start: d(0), end: d(0), status: 'todo',
      stages: [{ id: 'tp1', pid: null, name: '临时段', start: d(0), end: d(0), done: false }]
    }] });
    const reTemp = await act('/api/task/dispatch', { me: '1012', id: TOPWT, topStageId: 'tp1', who: '1003' });
    check('反向：临时任务不拆阶段，一级入口被拒', reTemp.ok === false && /不拆阶段/.test(reTemp.msg || ''), JSON.stringify(reTemp));
    await push('1012', { del: { tasks: [otherChild && otherChild.id, TOPWT].filter(Boolean) } });
    await push('1012', { del: { tasks: [TOPW] } });

    /* ---------- 9.10 界面上的「谁做」：真拨那个下拉，不是调接口 ----------
       教训：上一版 127 条断言全绿，而下拉拨完什么都不发生——
       stage-who 挂在 click 上，change 里没接，点开读到的是旧值。
       断言走的是 /api/sync，界面坏了它看不见。这里每一步都从 DOM 出发。 */
    const UIW = 't_e2e_uiwho';
    await push('1012', { del: { tasks: [UIW] } });
    await pushJ('1012', { tasks: [{ id: UIW, type: 'special', title: 'E2E界面改人', ownerNo: '1012', assigneeNo: '1012',
      start: d(0), end: d(6), dueDate: d(6), status: 'todo',
      stages: [
        { id: 'u1', pid: null, name: '整段', start: d(0), end: d(6), done: false },
        { id: 'u2', pid: 'u1', name: '子段', start: d(0), end: d(6), done: false }
      ] }] });
    await whoAmI('1012');
    await js(`openTaskPage('${UIW}');'ok'`); await sleep(800);

    const uiRow = await js(`(function(){
      const rows=[...document.querySelectorAll('#view .stage')];
      return {n:rows.length, h:rows.map(r=>Math.round(r.getBoundingClientRect().height)),
        subText:((document.querySelector('#view .stage.sub .t')||{}).innerText||'').replace(/\\s+/g,' '),
        hasSel:!!document.querySelector('#view .stage.sub .who-sel')};})()`);
    check('详情页子任务行：一行装得下名称和日期，不再每样占一行',
      uiRow.n === 2 && uiRow.h.every(h => h <= 46) && uiRow.hasSel,
      JSON.stringify(uiRow));

    const uiPick = await js(`(async()=>{
      const sel=document.querySelector('#view .stage.sub .who-sel');
      if(!sel) return {err:'行里没有「谁做」下拉'};
      const before=sel.value;
      sel.value='${SUBW}';
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      await new Promise(r=>setTimeout(r,900));
      const j=await (await fetch('/api/state?me=1012')).json();
      const t=(j.tasks||[]).find(x=>x.id==='${UIW}');
      const s=(t.stages||[]).find(x=>x.id==='u2');
      const row=document.querySelector('#view .stage.sub');
      const now=document.querySelector('#view .stage.sub .who-sel');
      return {before, dom:now&&now.value, rebuilt:now!==sel,
        dbWho:s&&s.who, dbWhoAt:s&&s.whoAt, tag:(row.querySelector('.subtag')||{}).innerText||''};})()`);
    check('详情页拨「谁做」下拉，选完就落库（不是只有下拉框自己变了）',
      uiPick && uiPick.dbWho === SUBW && uiPick.dbWhoAt === null, JSON.stringify(uiPick));
    check('换完人这一行立刻标「未派发」，不整页重绘（下拉不重建、不闪）',
      uiPick && (uiPick.tag || '').includes('未派发') && uiPick.rebuilt === false, JSON.stringify(uiPick));

    /* 「改」表单里也要能换人：用户第一反应是点「改」，进去发现没人可改就等于没有 */
    await js(`document.querySelector('#view .stage.sub [data-act="stage-edit"]').click();'ok'`);
    await sleep(300);
    const uiForm = await js(`(function(){
      const box=document.querySelector('#view .sedit');
      if(!box) return {err:'点「改」没有出现表单'};
      const sel=box.querySelector('[data-sedit-who]');
      return {has:!!sel, opts:sel?sel.querySelectorAll('option').length:0,
        head:(box.querySelector('.sedit-h')||{}).innerText||''};})()`);
    check('「改」表单里也有「谁做」，不用退出去找行内下拉',
      uiForm.has === true && uiForm.opts > 1, JSON.stringify(uiForm));

    const uiFormSave = await js(`(async()=>{
      const box=document.querySelector('#view .sedit');
      box.querySelector('[data-sedit-who]').value='1002';
      box.querySelector('[data-act="stage-save"]').click();
      await new Promise(r=>setTimeout(r,1000));
      const j=await (await fetch('/api/state?me=1012')).json();
      const t=(j.tasks||[]).find(x=>x.id==='${UIW}');
      const s=(t.stages||[]).find(x=>x.id==='u2');
      return {dbWho:s&&s.who, name:s&&s.name};})()`);
    check('在「改」表单里换人并保存，和行内下拉落到同一处',
      uiFormSave && uiFormSave.dbWho === '1002', JSON.stringify(uiFormSave));

    await push('1012', { del: { tasks: [UIW] } });
  }

  /* ---------- 9.11 完成态只有一份：子专项说完成，父阶段才算完成 ----------
     旧行为是父阶段 done 与副本 status 双向对齐，谁最后写谁说了算。
     现在子专项的 status 是唯一真相：父阶段不存 done，只读汇总；父方也勾不动。 */
  {
    const T = 't_e2e_upstream';
    const T2 = 't_e2e_upstream_del';
    const SUB = '1003', OTHER = '1004';
    const CH = 'nt_' + T + '_c1';
    const CH2 = 'nt_' + T2 + '_q1';
    const d = n => addDaysStr('2026-11-10', n);
    const login = async no => {
      await asUser(no);
      if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
        await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(800);
      }
    };
    const plan = [
      { id: 'p1', pid: null, name: '阶段一', start: d(0), end: d(6), done: false },
      { id: 'c1', pid: 'p1', name: '子任务A', who: SUB, start: d(0), end: d(2), done: false },
      { id: 'c2', pid: 'p1', name: '子任务B', start: d(3), end: d(6), done: false }
    ];
    await push('1012', { del: { tasks: [T, T2] } });
    await push(SUB, { del: { tasks: [CH, CH2] } });
    await push(OTHER, { del: { tasks: [CH, CH2] } });
    await pushJ('1012', { tasks: [{ id: T, type: 'special', title: 'E2E子任务上行',
      ownerNo: '1012', assigneeNo: '1012', start: d(0), end: d(6), dueDate: d(6), status: 'todo', stages: plan }] });
    /* 提醒是墓碑：上一轮留下的未读会替这一轮的断言交差，先读干净 */
    for (const no of [SUB, OTHER]) await act('/api/notice/seen', { me: no });
    await act('/api/task/dispatch', { me: '1012', id: T });
    /* 先把上级的旧提醒读掉：上一轮残留的 stage_done 不能替这一轮的正向断言交差。 */
    await act('/api/notice/seen', { me: '1012' });

    /* 上级侧：别人负责的那段没有勾选框，自己那段还在 */
    await login('1012');
    await js(`openTaskPage('${T}');'ok'`); await sleep(700);
    const supRow = await js(`(function(){
      const rows=[...document.querySelectorAll('#view .stage.sub')];
      const a=rows.find(r=>r.textContent.includes('子任务A'));
      const b=rows.find(r=>r.textContent.includes('子任务B'));
      return {aTick:!!(a&&a.querySelector('[data-act="stage-toggle"]')),
        aWhoSel:!!(a&&a.querySelector('[data-act="stage-who"]')),
        aTag:(a&&a.querySelector('.subtag')?a.querySelector('.subtag').innerText:''),
        bTick:!!(b&&b.querySelector('[data-act="stage-toggle"]'))};})()`);
    check('上级详情页：派出去那段没有勾选框、没有「谁做」，显示「待接收」；自己那段还能勾',
      supRow.aTick === false && supRow.aWhoSel === false && supRow.aTag.includes('待接收') && supRow.bTick === true,
      JSON.stringify(supRow));

    const supTry = await act('/api/stage/toggle', { me: '1012', id: T, stageId: 'c1', done: true });
    check('上级绕过界面直接勾别人那段 → 硬拒，文案与「别人负责」同口径',
      supTry.ok === false && supTry.msg === '这一段由别人负责，只有他能勾完成', JSON.stringify(supTry));

    /* 责任人接收：pending 变成自己名下的独立专项 */
    const acc = await act('/api/task/accept', { me: SUB, id: CH });
    const accRow = dbGet('SELECT * FROM task WHERE id=?', CH);
    check('责任人接收子专项：成为自己名下的专项，父引用保留',
      acc.ok === true && accRow.type === 'special' && accRow.owner_no === SUB
        && accRow.parent_task_id === T && accRow.parent_stage_id === 'c1',
      JSON.stringify({ acc, type: accRow && accRow.type, owner: accRow && accRow.owner_no }));

    /* 子专项是独立专项，不是只读副本：自己那份计划自己改 */
    await login(SUB);
    await js(`openTaskPage('${CH}');'ok'`); await sleep(700);
    const childUi = await js(`(function(){
      const ti=document.querySelector('#dTitle');
      return {editable:!!ti&&ti.readOnly===false,
        del:!!document.querySelector('#view [data-act="task-del"]'),
        src:(document.querySelector('#view').innerText||'').includes('来自「E2E子任务上行」'),
        statusSel:!!document.querySelector('[data-field="status"]')};})()`);
    check('子专项不再是只读副本：标题可改、能自己删，详情写明来自哪一段',
      childUi.editable === true && childUi.del === true && childUi.src === true && childUi.statusSel === true,
      JSON.stringify(childUi));

    /* 正向：责任人在自己的专项里把状态改成已完成 */
    await js(`(function(){
      const sel=document.querySelector('#view [data-field="status"]');
      sel.value='done'; sel.dispatchEvent(new Event('change',{bubbles:true})); return 'ok';})()`);
    await sleep(1500);
    /* 页面此时是责任人（1003）的身份，读 1012 的状态必须从 Node 侧带 1012 的会话取 */
    const supAfter = await js(`(async()=>{const j=${JSON.stringify(await stateAs('1012'))};
      const t=(j.tasks||[]).find(x=>x.id==='${T}');
      const s=(t.stages||[]).find(x=>x.id==='c1');
      return {done:!!s.done, by:s.doneBy, status:t.status, childStatus:s.child&&s.child.status,
        childProgress:s.child&&s.child.progress, prog:taskProg(t),
        doneNotice:(j.notices||[]).filter(n=>n.taskId==='${T}'&&n.kind==='stage_done').length};})()`);
    check('责任人完成子专项 → 父阶段由子专项派生为完成、父任务转进行中、收到一条完成提醒',
      supAfter.done === true && supAfter.by === SUB && supAfter.childStatus === 'done'
        && supAfter.status === 'doing' && supAfter.doneNotice === 1, JSON.stringify(supAfter));
    check('进度按子专项加权：两段里完成一段 = 50%，不是 0/100 二选一',
      supAfter.childProgress === 100 && supAfter.prog === 50,
      JSON.stringify({ child: supAfter.childProgress, parent: supAfter.prog }));

    await login('1012');
    await js(`openTaskPage('${T}');'ok'`); await sleep(700);
    const supKpi = await js(`(function(){
      const k=[...document.querySelectorAll('#view .td-kpis > div')].map(x=>x.innerText.replace(/\\s+/g,' '));
      return {txt:k.join(' | ')};})()`);
    check('上级详情页的完成计数跟着变（1 / 2，不再停在 0 / 2）',
      supKpi.txt.includes('1 / 2'), supKpi.txt.slice(0, 160));

    /* 提醒落在承接台「有变动的任务」：标签是「完成」，不是只有 API 里的 kind */
    await nav('intake'); await sleep(700);
    const noticeUi = await js(`(function(){
      const c=[...document.querySelectorAll('#view .card')].find(x=>x.textContent.includes('有变动的任务'));
      return {n:c?c.querySelectorAll('.rule-card').length:0,
        tags:c?[...c.querySelectorAll('.tag')].map(x=>x.textContent.trim()):[],
        txt:(c?c.innerText:'').replace(/\\s+/g,' ').slice(0, 200)};})()`);
    check('承接台「有变动的任务」：下属完成后上级看到「完成」标签',
      noticeUi.n >= 1 && noticeUi.tags.includes('完成') && noticeUi.txt.includes('子任务A'),
      JSON.stringify(noticeUi).slice(0, 220));

    /* 反向：旧快照整段提交（标题和日期改了，stages 还是完成前的） */
    const stale = JSON.parse(JSON.stringify(plan));
    await push('1012', { tasks: [{ id: T, title: 'E2E子任务上行（改标题）', end: d(7),
      ownerNo: '1012', assigneeNo: '1012', start: d(0), status: 'done', stages: stale }] });
    const afterStale = await js(`(async()=>{const j=${JSON.stringify(await stateAs('1012'))};
      const t=(j.tasks||[]).find(x=>x.id==='${T}');
      const s=(t.stages||[]).find(x=>x.id==='c1');
      const m=${JSON.stringify(await stateAs(SUB))};
      const child=(m.tasks||[]).find(x=>x.id==='${CH}');
      return {title:t.title, end:t.end, done:!!s.done, status:t.status,
        childStatus:child&&child.status};})()`);
    check('上级用旧快照改标题：标题落库，但子专项的完成没被冲掉',
      afterStale.title === 'E2E子任务上行（改标题）' && afterStale.done === true,
      JSON.stringify(afterStale));
    check('上级改计划字段（结束日）：计划真的落了库，完成态仍归子专项',
      afterStale.end === d(7) && afterStale.done === true, JSON.stringify(afterStale));
    check('旧快照里有未完成的段，任务也不会被写成「已完成」',
      afterStale.status === 'doing', 'status=' + afterStale.status);
    check('不反向下写子专项：上级提交的完成态影响不到它',
      afterStale.childStatus === 'done', '子专项=' + afterStale.childStatus);

    const otherTry = await act('/api/stage/toggle', { me: OTHER, id: T, stageId: 'c1', done: false });
    check('非责任人（第三个人）勾这段 → 被拒', otherTry.ok === false, JSON.stringify(otherTry));

    /* 段被移除：子专项脱钩保留，不再出现「副本被收走」这种连带删除 */
    await push('1012', { tasks: [{ id: T, ownerNo: '1012', assigneeNo: '1012', start: d(0), end: d(7),
      status: 'doing', stages: [
        { id: 'p1', pid: null, name: '阶段一', start: d(0), end: d(7), done: false },
        { id: 'c2', pid: 'p1', name: '子任务B', start: d(3), end: d(6), done: false }
      ] }] });
    const afterRemove = dbGet('SELECT * FROM task WHERE id=?', CH);
    check('父任务移除这一段：子专项脱钩保留，不清掉别人的活',
      !!afterRemove && !afterRemove.parent_task_id && !afterRemove.parent_stage_id && afterRemove.owner_no === SUB,
      JSON.stringify(afterRemove && [afterRemove.id, afterRemove.parent_task_id, afterRemove.owner_no]));

    /* 父任务被删：子专项保留成独立专项，并收到一条说明（决策②） */
    await pushJ('1012', { tasks: [{ id: T2, type: 'special', title: 'E2E父任务将被删',
      ownerNo: '1012', assigneeNo: '1012', start: d(0), end: d(2), dueDate: d(2), status: 'todo',
      stages: [
        { id: 'q0', pid: null, name: '整段', start: d(0), end: d(2), done: false },
        { id: 'q1', pid: 'q0', name: '交给别人', who: SUB, start: d(0), end: d(2), done: false }
      ] }] });
    await act('/api/task/dispatch', { me: '1012', id: T2 });
    await act('/api/task/accept', { me: SUB, id: CH2 });
    await push('1012', { del: { tasks: [T2] } });
    const orphan = dbGet('SELECT * FROM task WHERE id=?', CH2);
    const detachNotice = ((await stateAs(SUB)).notices || []).filter(n => n.taskId === CH2 && n.kind === 'detached');
    check('删父任务：子专项脱钩保留、不级联删，负责人收到「已成为独立专项」的说明',
      !!orphan && !orphan.parent_task_id && !orphan.parent_stage_id && detachNotice.length === 1,
      JSON.stringify({ exists: !!orphan, parent: orphan && orphan.parent_task_id, notices: detachNotice.length }));

    /* 清理：子专项归 1003，父任务归 1012，各自删各自的；顺便把本轮提醒标已读 */
    await push(SUB, { del: { tasks: [CH, CH2] } });
    await push('1012', { del: { tasks: [T] } });
    await act('/api/notice/seen', { me: SUB });
    await act('/api/notice/seen', { me: '1012' });
  }

  /* ---------- 9.12 三层封顶：第三级服务端硬拦，界面禁用并说明原因 ---------- */
  {
    const L1 = 't_e2e_depth1';
    const L2 = 'nt_' + L1 + '_s1';
    const L3 = 'nt_' + L2 + '_t1';
    const d = n => addDaysStr('2026-11-10', n);
    const login = async no => {
      await asUser(no);
      if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
        await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(800);
      }
    };
    await push('1012', { del: { tasks: [L1] } });
    await push('1003', { del: { tasks: [L2] } });
    await push('1004', { del: { tasks: [L3] } });
    await pushJ('1012', { tasks: [{ id: L1, type: 'special', title: 'E2E三层：一级',
      ownerNo: '1012', assigneeNo: '1012', start: d(0), end: d(6), dueDate: d(6), status: 'todo',
      stages: [
        { id: 's0', pid: null, name: '整段', start: d(0), end: d(6), done: false },
        { id: 's1', pid: 's0', name: '二级专项', who: '1003', start: d(0), end: d(6), done: false }
      ] }] });
    await act('/api/task/dispatch', { me: '1012', id: L1 });
    await act('/api/task/accept', { me: '1003', id: L2 });
    await pushJ('1003', { tasks: [{ id: L2, type: 'special', title: 'E2E三层：二级',
      ownerNo: '1003', assigneeNo: '1003', start: d(0), end: d(6), dueDate: d(6), status: 'todo',
      stages: [
        { id: 't0', pid: null, name: '整段', start: d(0), end: d(6), done: false },
        { id: 't1', pid: 't0', name: '三级专项', who: '1004', start: d(0), end: d(3), done: false }
      ] }] });
    const ok2 = await act('/api/task/dispatch', { me: '1003', id: L2 });
    await act('/api/task/accept', { me: '1004', id: L3 });
    check('第二级还能往下派一层：孙专项建出来了', ok2.ok === true && !!dbGet('SELECT id FROM task WHERE id=?', L3),
      JSON.stringify(ok2));

    await pushJ('1004', { tasks: [{ id: L3, type: 'special', title: 'E2E三层：三级',
      ownerNo: '1004', assigneeNo: '1004', start: d(0), end: d(3), dueDate: d(3), status: 'todo',
      stages: [
        { id: 'm0', pid: null, name: '整段', start: d(0), end: d(3), done: false },
        { id: 'm1', pid: 'm0', name: '想再派出去', who: '1005', start: d(0), end: d(2), done: false }
      ] }] });
    const deep = await act('/api/task/dispatch', { me: '1004', id: L3 });
    check('第三级再派 → 服务端硬拦，且不留下半条子任务',
      deep.ok === false && /三层/.test(deep.msg || '')
        && !dbGet('SELECT id FROM task WHERE parent_task_id=?', L3),
      JSON.stringify(deep));
    const deepTop = await act('/api/task/dispatch', { me: '1004', id: L3, topStageId: 'm0', who: '1005' });
    check('第三级借一级行入口也派不出去：深度在服务端先拒',
      deepTop.ok === false && /三层/.test(deepTop.msg || '')
        && !dbGet('SELECT id FROM task WHERE parent_task_id=? AND parent_stage_id=?', L3, 'm0'),
      JSON.stringify(deepTop));

    const st4 = await stateAs('1004');
    const d3 = (st4.tasks || []).find(t => t.id === L3);
    check('深度由服务端算：一级 1 / 二级 2 / 三级 3', d3 && d3.depth === 3, 'L3.depth=' + (d3 && d3.depth));

    await login('1004');
    await js(`openTaskPage('${L3}');'ok'`); await sleep(800);
    const deepUi = await js(`(function(){
      const btn=document.querySelector('#view [data-act="task-dispatch"]');
      const row=[...document.querySelectorAll('#view .stage.sub')].find(r=>r.textContent.includes('想再派出去'));
      return {hasBtn:!!btn, disabled:!!(btn&&btn.disabled), hint:(document.querySelector('#view').innerText||'').includes('第三级不能再派'),
        whoSel:!!(row&&row.querySelector('[data-act="stage-who"]')),
        rowHint:(row?row.innerText:'').includes('第三级不能再派')};})()`);
    check('第三级界面：派发按钮禁用并写明原因，不再给「谁做」下拉',
      deepUi.hasBtn === true && deepUi.disabled === true && deepUi.hint === true
        && deepUi.whoSel === false && deepUi.rowHint === true, JSON.stringify(deepUi));

    await push('1004', { del: { tasks: [L3] } });
    await push('1003', { del: { tasks: [L2] } });
    await push('1012', { del: { tasks: [L1] } });
  }


  /* 登录即激活——「派活能不能送到」全靠这一行。
     基线用直连 sqlite 把 activated 钉死，等于把这条实现替换成了测试自己的断言；
     所以必须单独验一次：登录真的会写标记，且登录后派活不再被拦。 */
  const loginAct = await (async () => {
    const roster = (await stateAs('1012')) || {};
    const before = (roster.roster || []).find(e => e.no === '1102') || {};
    const r = await loginSid('1102', '1102');
    const after = ((await stateAs('1012')) || {}).roster || [];
    const a = after.find(e => e.no === '1102') || {};
    /* 登录后立刻派一条过去：这才是「他真能收到活」的证明 */
    const w = await apiAs('1012', '/api/sync', { me: '1012', tasks: [{ id: 'e2e_login_assign', type: 'assign', title: 'E2E登录后派活',
      ownerNo: '1012', assigneeNo: '1102', start: '2026-11-04', end: '2026-11-05', status: 'todo', stages: [] }] });
    await apiAs('1012', '/api/sync', { me: '1012', del: { tasks: ['e2e_login_assign'] } });
    const wj = w.json || {};
    return { ok: r.ok, before: !!before.activated, after: !!a.activated, rows: wj.rows | 0, errs: (wj.errors || []).length };
  })();
  check('登录成功后立即置 activated，同一个人马上就能被派活',
    loginAct.ok === true && loginAct.before === false && loginAct.after === true
      && loginAct.rows > 0 && loginAct.errs === 0, JSON.stringify(loginAct));

  /* 跑完把 1102 还原成「没登录过」。不复位的话，真实库里会留一条测试造的登录记录——
     下次打开发布下拉，看到的是「测试说他登录过」，不是业务事实。 */
  execFileSync(process.execPath, ['--no-warnings', '-e', `
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(${JSON.stringify(DB)});
    db.prepare("UPDATE emp SET activated=0,last_login=NULL WHERE no='1102'").run();
    db.prepare("UPDATE meta SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k='rev'").run();
    db.close();`], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore' });

  await asUser('1012');
  await nav('special'); await sleep(500);

  /* ---------- 9.5 三级节点：阶段下可再拆一级子任务 ---------- */
  await js(`document.querySelector('[data-act="new"][data-type="special"]').click();'ok'`);
  await sleep(400);
  await js(`(function(){
    document.querySelector('#f_title').value='E2E三级：阶段带子任务';
    /* 固定挑一个演示数据不挤的工作日：这条用例要的是「日历上出的是子任务名」，
       落到人多手杂的那天，断言会被别的条目搅浑。 */
    document.querySelector('#f_start').value='2026-11-24';
    document.querySelector('#f_end').value='2026-11-24';
    const r=document.querySelector('#stageRows .mrow');
    r.querySelector('.sname').value='阶段一';
    r.querySelector('.sst').value='2026-11-24';
    r.querySelector('.sen').value='2026-11-24';
    r.querySelector('[data-act="mstage-sub"]').click();
    return 'ok';
  })()`);
  await sleep(250);
  const subForm = await js(`(function(){
    const k=document.querySelector('#stageRows .mrow.sub');
    if(!k) return {n:0};
    k.querySelector('.sname').value='子任务A';
    k.querySelector('.sst').value='2026-11-24';
    k.querySelector('.sen').value='2026-11-24';
    const w=k.querySelector('.swho');
    if(w) w.value='1002';
    return {n:document.querySelectorAll('#stageRows .mrow').length,
      subHasAdd: !!k.querySelector('[data-act="mstage-sub"]'),
      snos:[...document.querySelectorAll('#stageRows .sno')].map(x=>x.textContent),
      phs:[...document.querySelectorAll('#stageRows .sname')].map(x=>x.placeholder),
      whoSel: !!w};})()`);
  check('阶段行可以加子任务，子行不再有「+子」（三级封顶）',
    subForm.n === 2 && subForm.subHasAdd === false, JSON.stringify(subForm));
  /* 界面语义：两个名字框长得一模一样，只有编号能分清谁是谁。
     这条是给人看的验收——「这是什么」都不清楚，功能对不对已经排第二位了。 */
  check('阶段行自带编号（1 / 1.1），子任务行有「谁做」下拉，不靠 placeholder 猜身份',
    JSON.stringify(subForm.snos) === JSON.stringify(['1', '1.1'])
      && subForm.whoSel === true
      && subForm.phs[0] !== subForm.phs[1],
    JSON.stringify(subForm.snos) + ' / ' + subForm.whoSel);
  await shot('18-stage-modal');

  await js(`document.querySelector('#modal [data-act="modal-ok"]').click();'ok'`);
  await sleep(1200);
  const tree = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
    const t=j.tasks.filter(x=>x.title==='E2E三级：阶段带子任务').pop();
    if(!t) return null;
    const p=t.stages.filter(s=>!s.pid), k=t.stages.filter(s=>s.pid);
    return {id:t.id,tops:p.length,subs:k.length,pidOk:p.length&&k.length?k[0].pid===p[0].id:false,
      who:k.length?k[0].who:null, whoAt:k.length?k[0].whoAt:null};})()`);
  check('专项能拆到「阶段 → 子任务」，父子挂对并落库',
    !!tree && tree.tops === 1 && tree.subs === 1 && tree.pidOk === true, JSON.stringify(tree));
  /* 自己建的专项里也能给子任务配人：分一段出去不是「派活」，不转移整条任务，
     所以不需要先发布。但人记下了先不通知，等「派发」那一下。 */
  check('自己建的专项里，子任务能直接选责任人：落 who，先不写 whoAt（等派发）',
    !!tree && tree.who === '1002' && !tree.whoAt, JSON.stringify({ who: tree && tree.who, whoAt: tree && tree.whoAt }));

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

    /* 用户就是在这一步卡住的：进到详情页想给子任务配人，只有名字和日期，没有「谁做」。
       详情页和新建弹窗必须给同一套能力，否则「接了活之后怎么分工」这件事就断了。 */
    await js(`document.querySelector('#view [data-act="stage-sub"]').click();'ok'`);
    await sleep(300);
    const subAddForm = await js(`(function(){const f=document.querySelector('#view .subadd');
      if(!f) return null;
      return {head:(f.querySelector('.subadd-h')||{}).innerText||'', who:!!f.querySelector('.swho'),
        whoOpts:f.querySelectorAll('.swho option').length,
        whoLabel:f.innerText.includes('谁做'),
        hasDate:f.querySelectorAll('input[type=date]').length};})()`);
    check('详情页里也能给子任务选责任人（不只新建弹窗能配）',
      !!subAddForm && subAddForm.who === true && subAddForm.whoOpts >= 2
        && subAddForm.whoLabel === true && subAddForm.hasDate === 2,
      JSON.stringify(subAddForm));
    check('新增子任务的框写清了「加在哪一段下面」，不是凭空冒出一个输入框',
      !!subAddForm && /第 \d+ 段/.test(subAddForm.head) && subAddForm.head.includes('下面加'),
      subAddForm && subAddForm.head);
    await shot('17b-subadd-form');
    /* 默认日期不再抄父阶段整段。这一段的窗口已经被「子任务A」占满了，
       新加的那条必须落在后面，并且框里要写清楚阶段会被撑到哪天。 */
    const subDefault = await js(`(function(){const f=document.querySelector('#view .subadd');
      if(!f) return null;
      const t=S.tasks.find(x=>x.id==='${tree.id}');
      const p=t.stages.find(s=>!s.pid), k=t.stages.find(s=>s.pid);
      return {sst:f.querySelector('.sst').value, sen:f.querySelector('.sen').value,
        pStart:p.start, pEnd:p.end, kEnd:k.end||k.start, tip:f.innerText};})()`);
    check('加子任务的默认日期不再抄父阶段整段（以前抄整段 = 保证第二条必和第一条重叠）',
      !!subDefault && !(subDefault.sst === subDefault.pStart && subDefault.sen === subDefault.pEnd),
      JSON.stringify(subDefault));
    check('窗口占满时说明装不下、要先把这一段延长，不当场硬塞进去',
      !!subDefault && /窗口外|装不下|延长/.test(subDefault.tip), subDefault && subDefault.tip);

    /* 同阶段重名：两条同名子任务在进度里算成两件独立的事，分母直接虚高 */
    const subDup = await js(`(function(){const f=document.querySelector('#view .subadd');
      f.querySelector('.sname').value='子任务A';
      f.querySelector('[data-act="stage-add-sub"]').click();
      return {msg:(document.querySelector('#toast')||{}).textContent||''};})()`);
    await sleep(300);
    check('同一阶段下重名子任务被拦下，并问清是改还是另起一条',
      subDup.msg.includes('已经有') && subDup.msg.includes('子任务A'), JSON.stringify(subDup));

    await js(`(function(){const b=document.querySelector('#view .subadd [data-act="subadd-cancel"]'); if(b) b.click(); return 'ok'})()`);
    await sleep(200);

    /* 阶段的起止是人设定的：有子任务照样能改，改完就是新窗口。
       以前这里是"锁住日期框 + 一个「拉长到」绕道"，等于让子任务反推阶段时间——方向是反的。 */
    const parEdit = await js(`(function(){
      document.querySelector('#view .stage:not(.sub) [data-act="stage-edit"]').click();
      const box=document.querySelector('#view .sedit');
      if(!box) return null;
      return {stDisabled:box.querySelector('.sst').disabled, enDisabled:box.querySelector('.sen').disabled,
        noExtend:!box.querySelector('[data-act="stage-extend"]'), tip:box.innerText};})()`);
    check('有子任务的阶段，起止日期照样能改（阶段时间由人设定，不由子任务反推）',
      !!parEdit && parEdit.stDisabled === false && parEdit.enDisabled === false && parEdit.noExtend === true,
      JSON.stringify(parEdit));
    await shot('17c-stage-edit-window');
    await js(`(function(){const b=document.querySelector('#view .sedit [data-act="sedit-cancel"]'); if(b) b.click(); return 'ok'})()`);
    await sleep(200);

    await js(`document.querySelector('.td-head [data-act="close"]').click();'ok'`); await sleep(300);
    await nav('calendar'); await sleep(700);
    const cal = await js(`(function(){const names=[...document.querySelectorAll('.chip.cal .lbl')].map(x=>x.textContent);
      return {sub:names.filter(t=>t.includes('子任务A')).length, parent:names.filter(t=>t.includes('阶段一')).length};})()`);
    check('日历上出的是子任务名，父阶段不再单独出一条',
      cal.sub >= 1 && cal.parent === 0, JSON.stringify(cal));

    /* 目标日不能写死：过了那一年这天，「拖到过去」会被拖拽守卫拦下，测试跟着过期。
       取「今天 + 3 天」并跳过周末（专项阶段不排周末，拖过去也看不见）。 */
    let TARGET = addDaysStr(new Date().toLocaleDateString('sv-SE'), 3);
    while ([0, 6].includes(new Date(TARGET + 'T00:00:00Z').getUTCDay())) TARGET = addDaysStr(TARGET, 1);
    await js(`moveTask('${tree.id}','${TARGET}',0);'ok'`);
    await sleep(900);
    const moved = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
      const t=j.tasks.find(x=>x.id==='${tree.id}');
      const p=t.stages.find(s=>!s.pid), k=t.stages.find(s=>s.pid);
      return {ps:p.start,ks:k.start,st:t.status};})()`);
    check('拖有子任务的阶段，子任务跟着平移同样的天数',
      moved.ps === TARGET && moved.ks === TARGET, JSON.stringify({ ...moved, TARGET }));

    /* 勾选放在拖动之后：勾完唯一子任务任务就完成了，已完成的任务拖不动。
       派发之后这一段就归 1002：父方勾不动（硬拒），必须他先接收、
       再在自己的子专项里把状态改成已完成，父阶段才由它派生。 */
    await act('/api/task/dispatch', { me: '1012', id: tree.id });
    const subStageId = await js(`(async()=>{const j=await (await fetch('/api/state?me=1012')).json();
      const t=j.tasks.find(x=>x.id==='${tree.id}'); const k=t.stages.find(s=>s.pid);
      return k?k.id:'';})()`);
    const treeChild = 'nt_' + tree.id + '_' + subStageId;
    const accTree = await act('/api/task/accept', { me: '1002', id: treeChild });
    const treeChildRow = dbGet('SELECT * FROM task WHERE id=?', treeChild) || {};
    await pushJ('1002', { tasks: [{ id: treeChild, type: 'special', title: treeChildRow.title,
      ownerNo: '1002', assigneeNo: '1002', start: treeChildRow.start_date, end: treeChildRow.end_date,
      dueDate: treeChildRow.due_date, status: 'done', stages: [] }] });
    check('子任务派出去后由接收人完成，父阶段跟着派生（父方自己勾不动）',
      accTree.ok === true && treeChildRow.intake_status === 'accepted',
      JSON.stringify({ acc: accTree, intake: treeChildRow.intake_status }));
    await goto(BASE); await sleep(1200); /* 接口勾的，页面得重新拉一次状态 */
    await js(`openTaskPage('${tree.id}');'ok'`); await sleep(700);
    const prog = await js(`(function(){const b=document.querySelectorAll('#view .td-kpis b');
      return {prog:b[0]?b[0].innerText:'',cnt:b[1]?b[1].innerText:''}})()`);
    check('勾完唯一的子任务 → 进度 100%，父阶段不重复计数',
      prog.prog === '100%' && prog.cnt === '1 / 1', JSON.stringify(prog));

    await push('1002', { del: { tasks: [treeChild] } });
    await push('1012', { del: { tasks: [tree.id] } });
    /* 派发提醒给 1002，完成提醒给承接人 1012——两边都要读掉，别留给下一轮角标 */
    await act('/api/notice/seen', { me: '1002' });
    await act('/api/notice/seen', { me: '1012' });
  }

  const tempForm = await js(`(function(){openNewTask('temp');
    const has=!!document.querySelector('#stageRows');
    document.querySelector('#modal [data-act="modal-cancel"]').click();
    return {has:has};})()`);
  await sleep(200);
  check('临时任务新建时没有阶段/子任务入口', tempForm.has === false, JSON.stringify(tempForm));

  /* 子任务越界：阶段窗口是人设的，拖子任务不会让窗口变长，越界就得拦下并指出怎么改 */
  const GRD = 't_e2e_drag_root';
  /* 夹具日期按今天平移：这套断言原来写死在 2026-11，到了 11 月中旬之后，
     「拖到 11-13」就成了拖到过去，被更早的一道校验拦下。平移后语义不变。 */
  const todayIso = await js(`TODAY`);
  const delta = Math.max(0, Math.round((Date.parse(todayIso) - Date.parse('2026-11-13')) / 86400000) + 2);
  const D = (d) => addDaysStr(d, delta);
  await push('1012', { tasks: [{ id: GRD, ownerNo: '1012', assigneeNo: '1012', type: 'special',
    title: 'E2E拖子任务越界', start: D('2026-11-03'), end: D('2026-11-25'), status: 'todo',
    stages: [
      { id: 'g1', pid: null, name: '第一段', start: D('2026-11-03'), end: D('2026-11-10'), done: false },
      { id: 'g2', pid: 'g1', name: '子一', start: D('2026-11-03'), end: D('2026-11-05'), done: false },
      { id: 'g3', pid: 'g1', name: '子二', start: D('2026-11-06'), end: D('2026-11-10'), done: false },
      /* 第二段留出空档，才测得到「延长第一段」本身，不被相邻段挡住 */
      { id: 'g4', pid: null, name: '第二段', start: D('2026-11-20'), end: D('2026-11-25'), done: false },
    ] }] });
  await js(`refresh(true);'ok'`); await sleep(900);
  const verdict = await js(`(function(){
    const t=S.tasks.find(x=>x.id==='${GRD}');
    if(!t) return null;
    const i=t.stages.findIndex(s=>s.id==='g3');
    const r=dragCheck(t,'${D('2026-11-13')}',i);
    return {ok:r.ok, why:r.why||''};})()`);
  check('子任务拖出阶段窗口被拦下，并说清先延长这一段',
    !!verdict && verdict.ok === false && verdict.why.includes('延长'), JSON.stringify(verdict));

  /* 阶段窗口就是设定的值，两个方向都要对：
     ① 延长窗口 → 阶段自己的日期变，子任务一个不动（以前会被子任务并集打回去）
     ② 缩到装不下子任务 → 拒绝，并指出是谁出界 */
  const editWin = (stageId, end) => js(`(function(){
    const t=S.tasks.find(x=>x.id==='${GRD}');
    openTaskPage(t.id);
    const idx=t.stages.findIndex(s=>s.id==='${stageId}');
    const row=[...document.querySelectorAll('#view .stage')].find(r=>{
      const b=r.querySelector('[data-act=stage-edit]'); return b&&Number(b.dataset.idx)===idx;});
    if(!row) return {err:'这一行没有改入口'};
    row.querySelector('[data-act=stage-edit]').click();
    const box=document.querySelector('#view .sedit');
    if(!box) return {err:'没展开编辑框'};
    const st=box.querySelector('.sst').value;
    box.querySelector('.sen').value='${end}';
    box.querySelector('[data-act=stage-save]').click();
    return {msg:(document.querySelector('#toast')||{}).textContent||'', st};})()`);

  const wide = await editWin('g1', D('2026-11-13'));
  await sleep(900);
  await js(`refresh(true);'ok'`); await sleep(700);
  const winAfter = await js(`(function(){
    const t=S.tasks.find(x=>x.id==='${GRD}');
    if(!t) return null;
    const g1=t.stages.find(s=>s.id==='g1');
    const g2=t.stages.find(s=>s.id==='g2'), g3=t.stages.find(s=>s.id==='g3');
    return {pEnd:g1.end, k2s:g2.start, k2e:g2.end, k3s:g3.start, k3e:g3.end};})()`);
  check('延长阶段窗口就生效：阶段自己变成新日期，里面的子任务一个不动',
    !!winAfter && winAfter.pEnd === D('2026-11-13') && winAfter.k2s === D('2026-11-03')
      && winAfter.k3e === D('2026-11-10'),
    JSON.stringify({ click: wide, after: winAfter }));

  const narrow = await editWin('g1', D('2026-11-08'));
  await sleep(700);
  check('阶段缩到装不下子任务时被拦，并指出是哪个子任务出界、该改哪边',
    narrow.msg.includes('子二') && narrow.msg.includes('延长'), JSON.stringify(narrow));

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
  const savedDb = await js(`(async()=>{const s=await (await fetch('/api/state?me=1012')).json();
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

  await asUser('1019');
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
  const mgrNow = async () => js(`(async()=>{const s=await (await fetch('/api/state?me=1019')).json();
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
  const login1020 = (await loginSid('1020', '1020')).ok;
  check('上级工号不存在时整批不写（1020 没进库）',
    outBad.includes('不在花名册里') && login1020 === false,
    outBad.trim().split('\n')[2] || '');

  // 测试账号用完直接删掉，别留在花名册里
  execFileSync(process.execPath, ['--no-warnings', '-e',
    `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
     db.prepare('DELETE FROM emp WHERE no=?').run('1019');
     db.prepare('UPDATE meta SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k=?').run('rev');`],
    { cwd: ROOT });

  /* ---------- 9.6 任务卡片上要写清「这条活是谁发布的」 ---------- */
  /* 发布人 ≠ 承接人：接收之后 owner 变成了承接人，卡片上如果只剩「承接」，
     承接人回头看这条活，分不清是别人派的还是自己起意干的；自己的活也不该每条都刷「我发布」。 */
  const T0 = ((await stateAs('1002')) || {}).today;
  const PUBCHK = 't_e2e_pubtag';
  await push('1012', { tasks: [{ id: PUBCHK, assigneeNo: '1002', type: 'assign',
    title: 'E2E发布人显示', start: T0, end: T0, status: 'todo' }] });
  /* 反例：不是派给你的人，点「接收」必须无效，而且库里一个字都不能动。
     只判 ok:false 不够——实现可能先改了行再返回 false；用 DB 直查看真实状态。 */
  const badAcc = await apiAs('1003', '/api/task/accept', { me: '1003', id: PUBCHK });
  const badRow = dbGet('SELECT owner_no, assignee_no, intake_status, type FROM task WHERE id=?', PUBCHK);
  check('非承接人接收 → ok:false，intake_status / owner_no 都不变',
    (badAcc.json || {}).ok === false && badRow.owner_no === '1012'
      && badRow.intake_status === 'pending' && badRow.assignee_no === '1002' && badRow.type === 'assign',
    JSON.stringify({ resp: badAcc.json, db: badRow }));

  const pubAcc = await act('/api/task/accept', { me: '1002', id: PUBCHK });
  check('（前置）1012 发布、1002 接收之后，这条活的发布人仍是 1012',
    pubAcc.ok === true, JSON.stringify(pubAcc));

  await asUser('1002');
  if (await js(`!!document.querySelector('[data-act=skip-mgr]')`)) {
    await js(`document.querySelector('[data-act=skip-mgr]').click();'ok'`); await sleep(1000);
  }
  await nav('today');
  const pubRow = await js(`(function(){
    const row=[...document.querySelectorAll('.trow')].find(r=>/E2E发布人显示/.test(r.innerText));
    if(!row) return {found:false};
    const m=row.querySelector('.meta'); const el=m&&m.querySelector('.pubm');
    return {found:true, has:!!el, text:el?el.innerText.replace(/\\s+/g,' ').trim():'',
      tip:el?el.getAttribute('title'):''}})()`);
  check('今日待办的任务行写明发布人（不是「我」，是我上面派下来的那个人）',
    pubRow.found && pubRow.has && /王磊 发布/.test(pubRow.text) && !!pubRow.tip, JSON.stringify(pubRow));

  await nav('special');
  const pubCard = await js(`(function(){
    const cards=[...document.querySelectorAll('.rule-card')];
    const mine=cards.find(c=>/E2E发布人显示/.test(c.innerText));
    const self=cards.find(c=>/客户画像标签体系重建/.test(c.innerText));
    const t=mine&&mine.querySelector('.tag.pub'); const s=self&&self.querySelector('.tag.pub');
    return {card:!!mine, selfCard:!!self, pub:t?t.innerText.replace(/\\s+/g,' ').trim():'', selfPub:!!s}})()`);
  check('专项工作卡片标出发布人；自己起的活不标（不刷「我发布」）',
    pubCard.card && pubCard.pub === '王磊 发布' && pubCard.selfCard && pubCard.selfPub === false,
    JSON.stringify(pubCard));

  /* 模板里把布尔值直接插值会渲染成字面量 false（`${r.sub && ...}` 命中一级阶段时）。
     断言不看某一个夹具，而是整页所有阶段行：既有行必须存在，且任何一行都不许出现独立 false。 */
  const falseRows = await js(`(function(){
    const rows=[...document.querySelectorAll('#view .rule-card .stage')];
    const bad=rows.filter(r=>/(^|\\s)false(\\s|$)/.test(r.innerText));
    return {total:rows.length, bad:bad.length, sample:bad.slice(0,2).map(r=>r.innerText.replace(/\\s+/g,' ').slice(0,80))};})()`);
  check('专项卡片阶段行不把布尔值渲染成 false',
    falseRows.total > 0 && falseRows.bad === 0, JSON.stringify(falseRows));

  await push('1002', { del: { tasks: [PUBCHK] } });
  await push('1012', { del: { tasks: [PUBCHK] } });

  /* ---------- 10.5 认证与导出（第一批） ---------- */
  /* 这一节全部走 Node 侧带 cookie 调用：
     ① 浏览器里的 fetch 没法换身份（HttpOnly 的 sid 读不到也改不了）；
     ② 故意的 401/403 会污染「无失败请求」那条断言。 */
  const csvSplit = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };

  const anon = await fetch(BASE + '/api/state');
  check('不带会话调 /api/state → 401', anon.status === 401, String(anon.status));
  check('401 文案不区分「工号不存在」还是「没登录」',
    /登录已过期/.test((await anon.json()).msg || ''));

  const conflicted = await apiAs('1012', '/api/state?me=1002');
  check('会话是 1012 却带 me=1002 → 403（不静默当成 1002）', conflicted.status === 403, String(conflicted.status));

  const wrongPwd = await loginSid('1012', 'definitely-not-the-password');
  const ghost = await loginSid('999999', 'whatever');
  check('密码错与工号不存在返回同一句文案',
    wrongPwd.ok === false && ghost.ok === false && wrongPwd.msg === ghost.msg && wrongPwd.msg === '工号或密码不正确',
    `密码错=${wrongPwd.msg} / 没这人=${ghost.msg}`);

  /* --- 导出：鉴权反例（不能只靠 /api/state 的 401/403 倒推导出也挡住了） --- */
  const expAnon = await fetch(BASE + '/api/export/tasks.csv');
  check('导出：无 cookie → 401（不是回一份空 CSV）', expAnon.status === 401, String(expAnon.status));
  const expOther = await fetch(BASE + '/api/export/tasks.csv?me=1002',
    { headers: { Cookie: 'sid=' + (await sidOf('1012')) } });
  check('导出：?me=别人 → 403（身份只认 cookie）', expOther.status === 403, String(expOther.status));

  /* --- 导出：结构 --- */
  const exp = await fetch(BASE + '/api/export/tasks.csv', { headers: { Cookie: 'sid=' + (await sidOf('1012')) } });
  const raw = Buffer.from(await exp.arrayBuffer());
  check('导出是 CSV 且以 UTF-8 BOM 开头',
    exp.status === 200 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
    `${exp.status} / ${raw[0]},${raw[1]},${raw[2]}`);
  const csvText = raw.slice(3).toString('utf8').replace(/^\uFEFF/, '');
  const csvLines = csvText.split('\r\n').filter(l => l.length);
  check('前 3 行是 # 注释：格式版本 / 导出人 / 导出时间',
    csvLines[0] === '# cadence-tasks v1' && /^# 导出人：1012/.test(csvLines[1]) && /^# 导出时间：\d{4}-/.test(csvLines[2]),
    csvLines.slice(0, 3).join(' | '));
  const header = csvSplit(csvLines[3]);
  check('第 4 行是 27 列中文表头（列名与顺序冻结，父子关系两列在末尾）',
    header.length === 27 && header[0] === '任务编号' && header[15] === '分类一ID'
      && header[24] === '父阶段编号' && header[25] === '父任务编号' && header[26] === '父任务阶段编号',
    header.length + ' 列');

  /* --- 导出：范围与「一行一阶段」 --- */
  const prep = await apiAs('1012', '/api/sync', { me: '1012', tasks: [
    { id: 't_e2e_export', type: 'special', title: 'E2E导出,含"引号"', ownerNo: '1012', assigneeNo: '1012',
      start: '2026-11-01', end: '2026-11-10', dueDate: '2026-11-20', status: 'paused', imp: 3, urg: 2,
      cat1: '1012_c2', cat2: '1012_c22',
      stages: [
        { id: 'e1', pid: null, name: '段一', start: '2026-11-01', end: '2026-11-10', done: true, doneAt: '2026-11-09' },
        /* 这一段原来挂在 e1 下面、日期却越出 e1 的窗口（11-11 起，父段只到 11-10），
           任务周期也只写到最后一段之外——那是「区间不变量」还没上服务端时的野数据。
           现在由服务端判：子段收进父窗口、任务周期取包络，于是任务结束日改成 11-10。 */
        { id: 'e2', pid: 'e1', name: '段二', start: '2026-11-05', end: '2026-11-10', done: false }
      ] },
    { id: 't_e2e_export_done', type: 'special', title: 'E2E导出已完成', ownerNo: '1012', assigneeNo: '1012',
      start: '2026-11-01', end: '2026-11-08', dueDate: '2026-11-08', status: 'done',
      stages: [{ id: 'd1', pid: null, name: '整段', start: '2026-11-01', end: '2026-11-08', done: true, doneAt: '2026-11-08' }] },
    /* 临时任务：无阶段，导出应整条占一行、阶段列留空；不能因为没阶段被漏掉 */
    { id: 't_e2e_export_temp', type: 'temp', title: 'E2E临时任务', ownerNo: '1012', assigneeNo: '1012',
      start: '2026-11-12', end: '2026-11-12', dueDate: '2026-11-12', cat1: '1012_c2' }
  ] });
  check('导出用例任务写入成功', (prep.json || {}).ok === true && ((prep.json || {}).errors || []).length === 0,
    JSON.stringify((prep.json || {}).errors || []).slice(0, 200));

  const exp2 = await fetch(BASE + '/api/export/tasks.csv', { headers: { Cookie: 'sid=' + (await sidOf('1012')) } });
  const lines2 = Buffer.from(await exp2.arrayBuffer()).toString('utf8').split('\r\n').filter(l => l.length);
  const rows2 = lines2.slice(4).map(csvSplit);

  const stNow = (await stateAs('1012')) || {};
  const mineTasks = (stNow.tasks || []).filter(t => (t.type === 'routine' || t.type === 'special' || t.type === 'temp')
    && t.ownerNo === '1012' && (!t.assigneeNo || t.assigneeNo === '1012'));
  const mineIds = new Set(mineTasks.map(t => t.id));
  const fileIds = new Set(rows2.map(r => r[0]).filter(Boolean));
  check('导出的任务集合 == 我直接负责/已承接的常规+专项+临时',
    fileIds.size === mineIds.size && [...fileIds].every(id => mineIds.has(id)),
    `文件 ${fileIds.size} / 库里 ${mineIds.size}`);
  /* 临时任务也要导，但「我发布、别人还没接」的 assign 仍不能出现 */
  const assignIds = new Set(dbAll(`SELECT id FROM task WHERE type='assign' AND owner_no='1012'`).map(r => r.id));
  check('导出不包含发布给别人的待接收任务',
    assignIds.size > 0 && ![...fileIds].some(id => assignIds.has(id)),
    `assign ${assignIds.size} 条 / 文件里 ${[...fileIds].filter(id => assignIds.has(id)).length} 条`);
  const otherTemp = new Set(dbAll(`SELECT id FROM task WHERE type='temp' AND owner_no<>'1012'`).map(r => r.id));
  check('导出不包含别人的临时任务',
    ![...fileIds].some(id => otherTemp.has(id)),
    `别人的临时任务 ${otherTemp.size} 条 / 文件里混入 ${[...fileIds].filter(id => otherTemp.has(id)).length} 条`);
  const tempRow = rows2.filter(r => r[0] === 't_e2e_export_temp');
  check('临时任务出现在导出里，类型列是「临时」，整条只占一行',
    tempRow.length === 1 && tempRow[0][2] === '临时' && tempRow[0][1] === 'E2E临时任务',
    JSON.stringify(tempRow.map(r => [r[0], r[1], r[2]])));
  check('临时任务行阶段相关列全空',
    tempRow.length === 1 && tempRow[0].slice(17).every(v => v === ''),
    JSON.stringify(tempRow.length ? tempRow[0].slice(17) : null));

  /* 用 DB 直查对账：上面那条是「文件 vs /api/state」，两边都出自同一个接口实现，
     真出偏差时会一起错。这里换成与接口无关的 SQL，按 Spec §4.1 的定义域直接取。 */
  const dbIds = new Set(dbAll(`SELECT id FROM task WHERE type IN ('routine','special','temp') AND owner_no='1012'
      AND (assignee_no IS NULL OR assignee_no='' OR assignee_no='1012')`).map(r => r.id));
  check('导出集合与库里直查一致（不拿 /api/state 自证）',
    dbIds.size === fileIds.size && [...dbIds].every(id => fileIds.has(id)),
    `库 ${dbIds.size} / 文件 ${fileIds.size}`);

  /* 换个人导出：文件里只能有他自己的任务。共用同一份数据时最容易漏的就是这条。 */
  const expB = await fetch(BASE + '/api/export/tasks.csv', { headers: { Cookie: 'sid=' + (await sidOf('1002')) } });
  const rowsB = expB.status === 200
    ? Buffer.from(await expB.arrayBuffer()).toString('utf8').split('\r\n').filter(l => l.length).slice(4).map(csvSplit)
    : [];
  const ownersB = new Set(rowsB.map(r => r[4]).filter(Boolean));
  check('第二个用户导出：只有他自己的任务，不含他人任务 id',
    expB.status === 200 && rowsB.length > 0 && [...ownersB].every(no => no === '1002')
      && !rowsB.some(r => r[0] === 't_e2e_export'),
    `${expB.status} / 负责人列=${[...ownersB].join(',')} / ${rowsB.length} 行`);

  const expectRows = mineTasks.reduce((n, t) => n + Math.max(1, (t.stages || []).length), 0);
  check('行数 = 任务数 + 阶段数（无阶段任务占一行）', rows2.length === expectRows, `实际 ${rows2.length} / 期望 ${expectRows}`);

  const contBad = rows2.filter(r => !r[0]).filter(r => r.slice(0, 17).some(v => v !== '')).length;
  check('续行规则：后续阶段行的任务级列必须全空', contBad === 0, `非空续行 ${contBad}`);

  /* 规则实例的步骤没有 id：以前导出按 id 过滤，这些段在页面上有、文件里没有（静默吞掉 12 行）。
     R1a 要求照样一行，这里卡住它别再退化。 */
  const idless = mineTasks.reduce((n, t) => n + (t.stages || []).filter(s => s && !s.id && s.name).length, 0);
  const blankIdRows = rows2.filter(r => r[17] === '' && (r[18] || '') !== '').length;
  check('无编号阶段照样占一行（不按 id 静默丢掉）', idless > 0 && blankIdRows === idless,
    `无编号阶段 ${idless} / 文件里 ${blankIdRows}`);

  const expRow = rows2.filter(r => r[0] === 't_e2e_export');
  const expCont = rows2.filter(r => !r[0] && r[17] === 'e2');
  const expS1 = (((stNow.tasks || []).find(t => t.id === 't_e2e_export') || {}).stages || []).find(s => s.id === 'e1') || {};
  check('一行一阶段：两段拆两行，第二行任务级列留空',
    expRow.length === 1 && expCont.length === 1 && expCont[0][0] === '',
    `${expRow.length} / ${expCont.length}`);
  const r0 = expRow[0] || [];
  check('暂缓任务原样导出为「暂缓」（四值不降级）', r0[3] === '暂缓', `状态=${r0[3]}`);
  check('标题里的逗号和引号按 RFC4180 转义后能原样读回',
    r0[1] === 'E2E导出,含"引号"', `读回=${r0[1]}`);
  check('分类主列是名称、末尾 ID 列是原值', r0[6] === '业务交付' && r0[15] === '1012_c2' && r0[16] === '1012_c22',
    `${r0[6]} / ${r0[15]} / ${r0[16]}`);
  check('阶段列带编号/名称/负责人/完成/完成日/父阶段编号',
    r0[17] === 'e1' && r0[18] === '段一' && r0[19] === '2026-11-01' && r0[20] === '2026-11-10'
    && r0[21] === '' && r0[22] === '1' && r0[23] === String(expS1.doneAt || '') && r0[23] !== ''
    && expCont[0][24] === 'e1',
    JSON.stringify(expRow[0].slice(17)));

  const doneRow = rows2.find(r => r[0] === 't_e2e_export_done') || [];
  const doneSt = (((stNow.tasks || []).find(t => t.id === 't_e2e_export_done') || {}).stages || [])[0] || {};
  check('已完成任务的「完成日期」取叶子阶段 doneAt',
    doneRow[3] === '已完成' && doneSt.doneAt && doneRow[13] === doneSt.doneAt,
    `${doneRow[3]} / ${doneRow[13]} vs ${doneSt.doneAt}`);

  /* --- 导出：父子关系两列；派出去的段，负责人/完成读子专项（派生值） --- */
  const PEXP = 't_e2e_parent_export';
  const CEXP = 'nt_' + PEXP + '_z1';
  await push('1012', { del: { tasks: [PEXP] } });
  await push('1003', { del: { tasks: [CEXP] } });
  await pushJ('1012', { tasks: [{ id: PEXP, type: 'special', title: 'E2E导出父任务',
    ownerNo: '1012', assigneeNo: '1012', start: '2026-11-01', end: '2026-11-10', dueDate: '2026-11-10', status: 'todo',
    stages: [
      { id: 'z0', pid: null, name: '整段', start: '2026-11-01', end: '2026-11-10', done: false },
      { id: 'z1', pid: 'z0', name: '派出去那段', who: '1003', start: '2026-11-01', end: '2026-11-05', done: false }
    ] }] });
  await act('/api/task/dispatch', { me: '1012', id: PEXP });
  await act('/api/task/accept', { me: '1003', id: CEXP });
  await apiAs('1003', '/api/sync', { me: '1003', tasks: [{ id: CEXP, title: 'E2E导出父任务 · 派出去那段',
    type: 'special', ownerNo: '1003', assigneeNo: '1003', start: '2026-11-01', end: '2026-11-05',
    dueDate: '2026-11-05', status: 'done', stages: [] }] });

  const expP = await fetch(BASE + '/api/export/tasks.csv', { headers: { Cookie: 'sid=' + (await sidOf('1012')) } });
  const rowsP = Buffer.from(await expP.arrayBuffer()).toString('utf8').split('\r\n').filter(l => l.length).slice(4).map(csvSplit);
  const pRow = rowsP.find(r => r[0] === PEXP) || [];
  const z1Row = rowsP.find(r => r[0] === '' && r[17] === 'z1') || [];
  check('导出：顶层任务的「父任务编号 / 父任务阶段编号」留空',
    pRow.length === 27 && pRow[25] === '' && pRow[26] === '', JSON.stringify((pRow || []).slice(25)));
  check('导出：派出去那一段的负责人与完成态读子专项（不落回 stage.who）',
    z1Row.length === 27 && z1Row[21] === '1003' && z1Row[22] === '1' && z1Row[23] !== '' && z1Row[24] === 'z0',
    JSON.stringify((z1Row || []).slice(21)));

  const expC = await fetch(BASE + '/api/export/tasks.csv', { headers: { Cookie: 'sid=' + (await sidOf('1003')) } });
  const rowsC = Buffer.from(await expC.arrayBuffer()).toString('utf8').split('\r\n').filter(l => l.length).slice(4).map(csvSplit);
  const cRow = rowsC.find(r => r[0] === CEXP) || [];
  check('导出：子专项那行填上父任务编号与父任务阶段编号（按列名可回灌）',
    cRow.length === 27 && cRow[25] === PEXP && cRow[26] === 'z1'
      && cRow.slice(17, 25).every(v => v === ''), JSON.stringify((cRow || []).slice(25)));
  await push('1003', { del: { tasks: [CEXP] } });
  await push('1012', { del: { tasks: [PEXP] } });

  await apiAs('1012', '/api/sync', { me: '1012', del: { tasks: ['t_e2e_export', 't_e2e_export_done'] } });

  /* --- 改密：旧密码失效、新密码可用、其它会话被吊销 --- */
  const otherSid = (await loginSid('1004')).sid;
  const chg = await apiAs('1004', '/api/password', { me: '1004', old: '1004', new: 'E2ePassw0rd' });
  const oldLogin = await loginSid('1004', '1004');
  const newLogin = await loginSid('1004', 'E2ePassw0rd');
  const kicked = await fetch(BASE + '/api/state', { headers: { Cookie: 'sid=' + otherSid } });
  check('改密后：旧密码失效、新密码可用', (chg.json || {}).ok === true && oldLogin.ok === false && newLogin.ok === true,
    `改密=${(chg.json || {}).ok} 旧=${oldLogin.ok} 新=${newLogin.ok}`);
  check('改密会吊销本人的其它会话（当前这条保留）', kicked.status === 401, String(kicked.status));
  const selfStill = await fetch(BASE + '/api/state', { headers: { Cookie: 'sid=' + (await sidOf('1004')) } });
  check('改密用的当前会话仍然有效', selfStill.status === 200, String(selfStill.status));

  /* --- 退出登录 --- */
  const l5 = await loginSid('1005');
  const lo = await fetch(BASE + '/api/logout', {
    method: 'POST', headers: { Cookie: 'sid=' + l5.sid, 'Content-Type': 'application/json' }, body: '{}'
  });
  const afterLo = await fetch(BASE + '/api/state', { headers: { Cookie: 'sid=' + l5.sid } });
  check('退出登录后会话立即失效', lo.status === 200 && afterLo.status === 401, `${lo.status}/${afterLo.status}`);

  /* 一个从没登录过的新人：库里连 cred 行都还没有，但密码同样是工号。
     名单口径必须包含他，否则「还在用初始密码的人」这张表会漏掉风险最大的一批。 */
  const NEVERNO = '1021';
  runImport(writeCsv('t-never.csv', '工号,姓名,岗位,部门,上级工号\n1021,唐宁,专员,产品部,\n'));
  const neverCred = dbGet('SELECT COUNT(*) c FROM cred WHERE no=?', NEVERNO);
  const neverHasCred = !!neverCred && neverCred.c > 0;

  /* --- 管理账号 admin（独立于花名册） ---
     初始密码是服务随机生成的（改密前每次启动都会重新生成并打印），
     所以由 verify.mjs 起测试实例时从 stdout 抓出来传进来；直接跑 e2e 时没有它，只能明确跳过。 */
  const ADMIN_PWD = process.env.CADENCE_TEST_ADMIN_PWD || '';
  const ADMIN_NEW = 'Admin-E2e-2026';
  const plainNo = '1012';
  if (!ADMIN_PWD) {
    check('管理账号用例：没有拿到一次性初始密码，本轮跳过', false,
      '请用 node _dev/verify.mjs --full（它会从启动日志抓密码并传入）');
  } else {
    const first = await loginSid('admin', ADMIN_PWD);
    const blocked = await fetch(BASE + '/api/state', { headers: { Cookie: 'sid=' + first.sid } });
    const blockedBody = await blocked.json().catch(() => ({}));
    check('admin 首次登录：返回 mustChange，改密前 /api/state 被拒',
      first.ok === true && first.admin === true && first.mustChange === true
        && blocked.status === 403 && blockedBody.mustChange === true,
      JSON.stringify({ ok: first.ok, admin: first.admin, mustChange: first.mustChange, st: blocked.status }));

    const adminInRoster = dbGet("SELECT COUNT(*) c FROM emp WHERE no='admin'");
    const stEmp = await stateAs(plainNo);
    check('admin 不在花名册里，也不出现在任何人的同事列表里',
      !!adminInRoster && adminInRoster.c === 0 && !((stEmp || {}).roster || []).some(x => x.no === 'admin'),
      `emp=${adminInRoster && adminInRoster.c}`);

    const chg = await fetch(BASE + '/api/password', {
      method: 'POST', headers: { Cookie: 'sid=' + first.sid, 'Content-Type': 'application/json' },
      body: JSON.stringify({ old: ADMIN_PWD, new: ADMIN_NEW })
    }).then(r => r.json()).catch(() => ({}));
    const asAdmin = await loginSid('admin', ADMIN_NEW);
    check('admin 改掉一次性密码后：新密码可登录、不再要求改密',
      chg.ok === true && asAdmin.ok === true && asAdmin.mustChange === false,
      JSON.stringify({ chg: chg.ok, login: asAdmin.ok, mustChange: asAdmin.mustChange }));

    const adminApi = async (path, body) => {
      const r = await fetch(BASE + path, {
        method: body ? 'POST' : 'GET',
        headers: Object.assign({ Cookie: 'sid=' + asAdmin.sid }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      let json = null;
      try { json = await r.json(); } catch { /* 非 JSON */ }
      return { status: r.status, json };
    };

    const st = await adminApi('/api/state');
    check('admin 的 /api/state 没有任何业务数据（任务/花名册/下属都为空）',
      st.status === 200 && (st.json || {}).admin === true
        && ((st.json || {}).tasks || []).length === 0 && ((st.json || {}).roster || []).length === 0,
      JSON.stringify({ status: st.status, tasks: ((st.json || {}).tasks || []).length }));

    const forbid = await apiAs(plainNo, '/api/admin/reset-password', { me: plainNo, no: '1004' });
    check('普通员工调用重置密码 → 403', forbid.status === 403, String(forbid.status));
    const forbidList = await apiAs(plainNo, '/api/admin/initial-passwords');
    check('普通员工看初始密码名单 → 403', forbidList.status === 403, String(forbidList.status));
    const forbidSess = await apiAs(plainNo, '/api/admin/sessions');
    check('普通员工看会话设备 → 403', forbidSess.status === 403, String(forbidSess.status));

    const reset = await adminApi('/api/admin/reset-password', { no: '1004' });
    const backLogin = await loginSid('1004', '1004');
    const staleSid = await fetch(BASE + '/api/state', { headers: { Cookie: 'sid=' + (await sidOf('1004')) } });
    check('admin 重置后：目标可用工号重新登录，旧会话全部失效',
      (reset.json || {}).ok === true && backLogin.ok === true && staleSid.status === 401,
      `${(reset.json || {}).ok}/${backLogin.ok}/${staleSid.status}`);

    const list = await adminApi('/api/admin/initial-passwords');
    const one = ((list.json || {}).list || []).find(x => x.no === '1004') || {};
    check('初始密码名单列出重置回来的人，并带首次登录时间/IP',
      (list.json || {}).ok === true && one.no === '1004' && !!one.firstLoginAt && 'firstLoginIp' in one,
      JSON.stringify(one).slice(0, 160));

    const never = ((list.json || {}).list || []).find(x => x.no === NEVERNO) || {};
    check('初始密码名单包含「从没登录过、仍是默认密码」的人（firstLoginAt 为空）',
      neverHasCred === false && never.no === NEVERNO && never.firstLoginAt === null && never.neverLoggedIn === true,
      `cred=${neverHasCred} / ${JSON.stringify(never).slice(0, 120)}`);

    const sess = await adminApi('/api/admin/sessions');
    const sessRows = (sess.json || {}).list || [];
    check('会话与设备：能看到 admin 自己的会话，且没有把 admin 当成员工',
      (sess.json || {}).ok === true && sessRows.some(x => x.no === 'admin')
        && !sessRows.some(x => x.no === '005822'),
      `${sessRows.length} 条`);
  }

  /* 临时工号用完删掉，别留在测试库花名册里 */
  execFileSync(process.execPath, ['--no-warnings', '-e',
    `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(${JSON.stringify(DB)});
     db.prepare('DELETE FROM cred WHERE no=?').run('${NEVERNO}');
     db.prepare('DELETE FROM emp WHERE no=?').run('${NEVERNO}');
     db.prepare('UPDATE meta SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k=?').run('rev');`],
  { cwd: ROOT, stdio: 'ignore' });

  /* --- 失败锁定：用一次性账号，避免把演示账号锁给下一轮 --- */
  const lockMsgs = [];
  for (let i = 0; i < 6; i++) lockMsgs.push((await loginSid(LOCKNO, 'wrong-' + i)).msg);
  const lockRight = await loginSid(LOCKNO, LOCKNO);
  check('连续 5 次密码错后第 6 次提示锁定',
    lockMsgs.slice(0, 5).every(m => m === '工号或密码不正确') && /尝试次数过多/.test(lockMsgs[5] || ''),
    JSON.stringify(lockMsgs.slice(0, 6)));
  check('锁定期内正确密码也被拒（不给爆破留后门）',
    lockRight.ok === false && lockRight.locked === true, JSON.stringify(lockRight));

  /* ---------- 11 错误汇总 ---------- */
  /* 登录页要先知道「有没有会话」，会探一次 /api/state；没会话必然回 401。
     那是设计出来的应答，不是错误——不排除它，这条断言永远红，最后只会被人加 ignore 注释。 */
  const urlOf = (requestId) => {
    const r = cdp.events.find((e) => e.method === 'Network.requestWillBeSent' && e.params?.requestId === requestId);
    return r ? r.params.request.url : '';
  };
  const probe401 = (e) => {
    const en = e.params?.entry || {};
    return /\/api\/state$/.test(en.url || '') && /401/.test(en.text || '');
  };
  const errs = cdp.events.filter((e) => {
    if (e.method === 'Runtime.exceptionThrown') return true;
    if (e.method === 'Runtime.consoleAPICalled') return e.params?.type === 'error';
    if (e.method === 'Log.entryAdded') return e.params?.entry?.level === 'error' && !probe401(e);
    return false;
  });
  const errText = (e) => {
    const en = e.params?.entry || {};
    if (e.method === 'Log.entryAdded') return `${en.url || ''} ${en.text || ''}`;
    if (e.method === 'Runtime.exceptionThrown') {
      return String(e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text || '').slice(0, 200);
    }
    return String(e.params?.args?.[0]?.value || e.params?.type || '').slice(0, 200);
  };
  const netFail = cdp.events.filter((e) => e.method === 'Network.loadingFailed' && !e.params?.canceled);
  check('无 JS 运行时错误', errs.length === 0, errs.slice(0, 5).map(errText).join(' | '));
  check('无失败请求', netFail.length === 0,
    netFail.slice(0, 5).map((e) => `${urlOf(e.params?.requestId)} ${e.params?.errorText || ''}`).join(' | '));

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
