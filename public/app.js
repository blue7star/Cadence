/* ==========================================================================
   初级管理者工作台 · MVP 前端
   数据全部走 /api，服务端 SQLite 持久化，多人共用同一份。
   ========================================================================== */
'use strict';

/* ============ 基础工具 ============ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [a, b, c] = String(s).split('-').map(Number); return new Date(a, b - 1, c); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);
const dow = s => parse(s).getDay();
const DOW_CN = ['日', '一', '二', '三', '四', '五', '六'];
const fmt = s => { if (!s) return '—'; const d = parse(s); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const fmtFull = s => { const d = parse(s); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${DOW_CN[d.getDay()]}`; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const uid = p => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
const monthStart = s => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth(), 1)); };
const monthEnd = s => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
const weekStart = s => addDays(s, -((dow(s) + 6) % 7));

let TODAY = iso(new Date());

/* ============ 节假日（由服务端下发，保证服务端生成实例与前端渲染一致） ============ */
let HOL = {}, MK = {};
function adoptHolidays(list) {
  HOL = {}; MK = {};
  (list || []).forEach(h => {
    if (h.kind === 'makeup') MK[h.date] = h.name || '补班';
    else HOL[h.date] = h.name || '休';
  });
}
const isHoliday = s => !!HOL[s];
const isMakeup = s => !!MK[s];
const isWorkday = s => isMakeup(s) ? true : (isHoliday(s) ? false : (dow(s) !== 0 && dow(s) !== 6));

/* ============ 常量 ============ */
const TYPES = {
  assign: { name: '任务制定', cls: 'assign' },
  routine: { name: '常规任务', cls: 'routine' },
  special: { name: '专项任务', cls: 'special' },
  temp: { name: '临时任务', cls: 'temp' }
};
const ST = {
  todo: { name: '待开展', cls: 'todo' },
  doing: { name: '进行中', cls: 'doing' },
  done: { name: '已完成', cls: 'done' },
  paused: { name: '暂缓', cls: 'paused' }
};
const LV = { 3: '高', 2: '中', 1: '低' };
const TITLES = {
  today: '今日待办', assign: '任务制定', routine: '常规工作', special: '专项工作',
  intake: '任务承接台', calendar: '日历待办', settings: '设置'
};

/* ============ 运行状态 ============ */
let S = null;                  /* 视图数据（内存缓存，真相在服务端） */
let REV = 0;
let SNAP = null;               /* 上次同步成功时的自有数据快照，用于算增量 */
let syncing = false;
let pendingRefresh = false;
let pollTimer = null;
let view = 'today', calCursor = monthStart(TODAY), calMode = 'month', selDay = TODAY;
let routineTab = 'month';
let openMembers = {};
let drawerId = null, modalOk = null;
let authStep = 'login', authPick = null, authKw = '';

const ME_KEY = 'pm_mvp_me';    /* 只存工号，数据一律在服务端 */

/* ============ API ============ */
async function api(path, opts) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' }
  }, opts));
  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : {}; } catch (e) { throw new Error('服务返回异常：' + txt.slice(0, 80)); }
  if (!res.ok) throw new Error(data.msg || ('HTTP ' + res.status));
  return data;
}

function setSync(state, text) {
  const el = $('#syncPill');
  if (!el) return;
  el.className = 'sync ' + (state || '');
  el.querySelector('span').textContent = text;
}

/* ============ 状态装载 ============ */
function nameOf(no) {
  if (!S) return '';
  if (no === S.me.no) return '我';
  const m = S.subs.find(x => x.no === no) || S.roster.find(x => x.no === no);
  return m ? m.name : no;
}

function adopt(st) {
  TODAY = st.today || TODAY;
  adoptHolidays(st.holidays);
  const meta = {};
  (st.routines || []).forEach(r => { meta[r.id] = r; });

  S = {
    me: { no: st.me.no, name: st.me.name, role: st.me.role, dept: st.me.dept, mgr: st.me.mgr || null },
    roster: st.roster || [],
    subs: st.subs || [],
    cats: st.cats || [],
    rules: st.rules || [],
    tasks: st.tasks || [],
    watch: st.watch || [],
    routineMeta: meta,
    members: [],
    intake: []
  };
  S.members = buildMembers();
  S.intake = buildIntake();
  REV = st.rev || 0;
  SNAP = signatures();
}

/* 自有数据签名：用于「改了才发」 */
function ownRows() {
  const me = S.me.no;
  const tasks = S.tasks
    .filter(t => t.ownerNo === me || t.assigneeNo === me)
    .map(t => ({
      id: t.id, type: t.type, title: t.title, ownerNo: t.ownerNo, assigneeNo: t.assigneeNo,
      start: t.start, end: t.end, time: t.time || '', std: t.std || '', status: t.status,
      cat1: t.cat1 || null, cat2: t.cat2 || null,
      imp: t.imp == null ? null : t.imp, urg: t.urg == null ? null : t.urg,
      stages: t.stages || [], routineId: t.routineId || null, planDate: t.planDate || null,
      sourceId: t.sourceId || null, detached: !!t.detached, intakeStatus: t.intakeStatus || null
    }));
  const rules = S.rules.map(r => ({
    id: r.id, title: r.title, cycle: r.cycle, policy: r.policy || 'prev',
    cat1: r.cat1 || null, cat2: r.cat2 || null, active: !!r.active, steps: r.steps || []
  }));
  const cats = [];
  S.cats.forEach(c => {
    cats.push({ id: c.id, name: c.name, level: 1 });
    (c.children || []).forEach(k => cats.push({ id: k.id, name: k.name, level: 2, parentId: c.id }));
  });
  const watch = (S.watch || []).map(w => ({ id: w.id, subNo: w.subNo, ruleId: w.ruleId }));
  return { tasks, rules, cats, watch };
}
function signatures() {
  const own = ownRows();
  const out = {};
  for (const k of Object.keys(own)) {
    out[k] = {};
    own[k].forEach(r => { out[k][r.id] = JSON.stringify(r); });
  }
  return out;
}

/* 保存：算增量 → 推服务端 → 拉回最新状态 */
function save() {
  persist().catch(e => {
    console.error(e);
    setSync('err', '保存失败');
    toast('保存失败：' + e.message);
  });
}

let saveQueued = false;
async function persist() {
  if (!S || !S.me) return;
  if (syncing) { saveQueued = true; return; }
  syncing = true;
  setSync('busy', '保存中');
  try {
    const own = ownRows();
    const body = { me: S.me.no, tasks: [], rules: [], cats: [], watch: [], del: { tasks: [], rules: [], cats: [], watch: [] } };
    for (const k of Object.keys(own)) {
      const cur = {};
      own[k].forEach(r => { cur[r.id] = JSON.stringify(r); });
      for (const id of Object.keys(cur)) if (SNAP[k][id] !== cur[id]) body[k].push(own[k].find(r => r.id === id));
      for (const id of Object.keys(SNAP[k])) if (!(id in cur)) body.del[k].push(id);
    }
    const changed = body.tasks.length + body.rules.length + body.cats.length + body.watch.length +
      body.del.tasks.length + body.del.rules.length + body.del.cats.length + body.del.watch.length;
    if (changed) await api('/api/sync', { method: 'POST', body: JSON.stringify(body) });
    SNAP = signatures();
    /* 连续操作时先别刷新，避免把还没推上去的改动冲掉 */
    if (!saveQueued) {
      await refresh(true);
      setSync('ok', '已同步');
    }
  } finally {
    syncing = false;
    if (saveQueued) { saveQueued = false; persist().catch(() => { }); }
    else if (pendingRefresh) { pendingRefresh = false; refresh(true).catch(() => { }); }
  }
}

async function refresh(silent) {
  if (!S || !S.me) return;
  const st = await api('/api/state?me=' + encodeURIComponent(S.me.no));
  const keepView = view;
  adopt(st);
  if (keepView !== view) view = keepView;
  if (!silent) setSync('ok', '已同步');
  if (canRerender()) render();
  else pendingRefresh = true;
}

function canRerender() {
  return !$('#modalWrap').classList.contains('show') && !$('#drawer').classList.contains('show') &&
    !$('#auth').classList.contains('show');
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (syncing || !S || !S.me) return;
    try {
      const r = await api('/api/rev');
      if (r.rev !== REV) {
        await refresh(true);
        setSync('ok', '已同步');
        toast('有新的更新，已刷新');
      } else {
        setSync('ok', '已同步');
      }
    } catch (e) {
      setSync('err', '连接中断');
    }
  }, 7000);
}

/* ============ 下属看板 / 承接台（全部由真实数据聚合） ============ */
/* 看板基准日：工作日看今天，周末/节假日看下一个工作日（否则管理者周末打开全是空的） */
const BOARD_DAY = (() => {
  let d = TODAY;
  for (let i = 0; i < 15 && !isWorkday(d); i++) d = addDays(d, 1);
  return d;
})();
const BOARD_LABEL = BOARD_DAY === TODAY ? '今日' : '下个工作日';
function cycleOfRule(rid) {
  const m = S.routineMeta[rid];
  return m ? m.cycle : 'month';
}
function buildMembers() {
  return S.subs.map(sub => {
    const rt = S.tasks.filter(t => t.type === 'routine' && t.ownerNo === sub.no);
    const byRule = {};
    rt.forEach(t => { (byRule[t.routineId] = byRule[t.routineId] || []).push(t); });
    const wkFrom = weekStart(TODAY), wkTo = addDays(wkFrom, 6);

    const routines = Object.keys(byRule).map(rid => {
      const list = byRule[rid].slice().sort((a, b) => a.planDate < b.planDate ? -1 : 1);
      const cur = list.find(t => t.end >= TODAY && t.status !== 'done') || list[list.length - 1] || null;
      let nodes = [];
      if (cur) {
        nodes = (cur.stages && cur.stages.length)
          ? cur.stages.map(s => ({ name: s.name, date: s.date, done: !!s.done }))
          : [{ name: '', date: cur.start, done: cur.status === 'done' }];
      }
      const wk = list.filter(t => t.planDate >= wkFrom && t.planDate <= wkTo);
      const done = list.filter(t => t.status === 'done').sort((a, b) => a.end < b.end ? -1 : 1);
      return {
        id: rid, title: (S.routineMeta[rid] || {}).title || (cur ? cur.title : '常规工作'),
        cycle: cycleOfRule(rid), nodes,
        weekDone: wk.filter(t => t.status === 'done').length, weekTotal: wk.length,
        lastDone: done.length ? done[done.length - 1].end : null
      };
    });

    /* 今日；非工作日看下一个工作日 */
    const todayNodes = [];
    rt.forEach(t => {
      const steps = (t.stages && t.stages.length) ? t.stages : [{ date: t.start, done: t.status === 'done' }];
      steps.forEach(s => { if (s.date === BOARD_DAY) todayNodes.push(!!s.done); });
    });
    const weekAll = rt.filter(t => t.planDate >= wkFrom && t.planDate <= wkTo);
    const rate = weekAll.length ? Math.round(weekAll.filter(t => t.status === 'done').length / weekAll.length * 100) : 0;

    const lateRoutine = routines.filter(r => {
      const c = r.nodes.find(n => !n.done);
      return c && c.date < TODAY;
    }).length;
    const lateTask = S.tasks.filter(t => t.type === 'assign' && t.assigneeNo === sub.no && t.status !== 'done' && t.end < TODAY).length;
    const alerts = [];
    if (lateRoutine) alerts.push(`常规逾期 ${lateRoutine} 项`);
    if (lateTask) alerts.push(`任务逾期 ${lateTask} 项`);

    return {
      no: sub.no, name: sub.name, role: sub.role, dept: sub.dept,
      todayDone: todayNodes.filter(Boolean).length, todayTotal: todayNodes.length,
      weekRate: rate, alert: alerts.join(' · '), routines
    };
  });
}

/* 承接台：上级派给我、还没被我承接的 assign 任务 */
function buildIntake() {
  return S.tasks
    .filter(t => t.type === 'assign' && t.assigneeNo === S.me.no && t.intakeStatus === 'pending')
    .map(t => ({
      id: t.id, task: t, title: t.title, from: nameOf(t.ownerNo),
      due: t.end, std: t.std, note: '', status: 'pending'
    }));
}
function acceptedList() {
  return S.tasks.filter(t => t.sourceId && t.ownerNo === S.me.no);
}

/* ============ 数据查询 ============ */
const catName = (c1, c2) => {
  const p = S.cats.find(c => c.id === c1);
  const k = p && (p.children || []).find(x => x.id === c2);
  return [p ? p.name : '未分类', k ? k.name : ''].filter(Boolean).join(' / ');
};
const prioScore = t => (t.imp || 0) + (t.urg || 0);
const prioLabel = t => {
  if (!t.imp && !t.urg) return null;
  const s = prioScore(t);
  return s >= 5 ? 'P0' : s >= 4 ? 'P1' : s >= 3 ? 'P2' : 'P3';
};
/* 我自己的待办：派给我的任务（未承接的除外）+ 我的专项/临时/常规 */
const isMineTask = t => {
  if (!t.assigneeNo || t.assigneeNo !== S.me.no) return false;
  if (t.type === 'assign' && t.intakeStatus === 'pending') return false;
  return true;
};

function occOn(date, mode) {
  const out = [];
  S.tasks.forEach(t => {
    if (!isMineTask(t)) return;
    if (t.type === 'routine' && t.stages && t.stages.length) {
      t.stages.forEach((s, i) => { if (s.date === date) out.push({ t, step: s, si: i }); });
      return;
    }
    if (t.start <= date && t.end >= date) {
      if (mode === 'ends' && t.type !== 'routine' && t.start !== t.end && date !== t.start && date !== t.end) return;
      out.push({ t, step: null, si: -1 });
    }
  });
  return out;
}
function sortOcc(list) {
  return [...list].sort((a, b) => {
    const pa = prioScore(a.t), pb = prioScore(b.t);
    if (pb !== pa) return pb - pa;
    const ta = (a.step && a.step.time) || a.t.time || '99';
    const tb = (b.step && b.step.time) || b.t.time || '99';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.t.start < b.t.start ? -1 : 1;
  });
}
const todayTasks = () => sortOcc(occOn(TODAY, 'all'));

function sortTasks(list) {
  return [...list].sort((a, b) => {
    const pa = prioScore(a), pb = prioScore(b);
    if (pb !== pa) return pb - pa;
    if ((a.time || '99') !== (b.time || '99')) return (a.time || '99') < (b.time || '99') ? -1 : 1;
    return a.start < b.start ? -1 : 1;
  });
}
const taskProg = t => {
  if (t.type === 'routine') return t.status === 'done' ? 100 : 0;
  if (t.stages && t.stages.length) return Math.round(t.stages.filter(s => s.done).length / t.stages.length * 100);
  return t.status === 'done' ? 100 : t.status === 'doing' ? 50 : 0;
};
const overdue = t => t.status !== 'done' && t.end < TODAY;

/* ============ 通用组件 ============ */
function typeChip(t) { return `<span class="chip ${t.type}">${TYPES[t.type].name}</span>`; }
function stTag(status) { return `<span class="tag ${ST[status].cls}">${ST[status].name}</span>`; }
function prioBadge(t) {
  const p = prioLabel(t);
  if (!p) return '';
  return `<span class="tag ${p === 'P0' ? 'red' : ''}">${p}</span>`;
}
function taskRow(t, step, si) {
  const done = step ? step.done : t.status === 'done';
  const delay = !step && t.auto && t.planDate && t.planDate !== t.start;
  const time = (step && step.time) || t.time;
  const title = step && step.name ? `${t.title} · ${step.name}` : t.title;
  const late = step ? (!step.done && step.date < TODAY) : overdue(t);
  const who = (t.assigneeNo && t.assigneeNo !== S.me.no) ? nameOf(t.assigneeNo) : '';
  return `<div class="trow ${done ? 'done' : ''}">
    <span class="bar ${t.type}"></span>
    <div class="cb ${done ? 'on' : ''}" data-act="${step ? 'toggle-step' : 'toggle'}" data-id="${t.id}"${step ? ` data-idx="${si}"` : ''}>${done ? '✓' : ''}</div>
    <div class="body">
      <div class="t"><b>${esc(title)}</b>${typeChip(t)}
        ${step ? (si + 1) + '/' + t.stages.length + ' 节点' : ST[t.status].name}
        ${prioBadge(t)}
        ${delay ? '<span class="tag" title="按规则调整过日期">日期已调整</span>' : ''}
        ${late ? '<span class="tag red">已逾期</span>' : ''}</div>
      <div class="meta">
        <span>${time ? time + ' · ' : ''}${t.start === t.end ? fmt(t.start) : fmt(t.start) + ' → ' + fmt(t.end)}</span>
        ${who ? `<span>承接：${esc(who)}</span>` : ''}
        <span>${catName(t.cat1, t.cat2)}</span>
      </div>
    </div>
    <div class="right"><button class="btn sm ghost" data-act="open" data-id="${t.id}">详情</button></div>
  </div>`;
}
function statCard(cls, label, n, extra) {
  return `<div class="stat ${cls}"><div class="lbl">${label}</div><div class="val">${n}${extra ? `<small>${extra}</small>` : ''}</div></div>`;
}

/* ============ 视图：今日待办 ============ */
function viewToday() {
  const mine = S.tasks.filter(t => isMineTask(t) && t.end >= addDays(TODAY, -30));
  const list = todayTasks();
  const doneN = list.filter(o => o.step ? o.step.done : o.t.status === 'done').length;
  const cnt = { todo: 0, doing: 0, done: 0, paused: 0 };
  mine.filter(t => t.type !== 'routine').forEach(t => cnt[t.status] = (cnt[t.status] || 0) + 1);
  const soon = sortTasks(mine.filter(t => t.type !== 'routine' && t.status !== 'done' && t.end >= TODAY && diffDays(t.end, TODAY) <= 3));
  const pending = S.intake;
  const pendingDone = S.members.reduce((a, m) => a + m.todayDone, 0);
  const pendingTotal = S.members.reduce((a, m) => a + m.todayTotal, 0);

  return `<div class="grid-2">
    <div>
      <div class="card">
        <div class="card-h">
          <h2>${fmtFull(TODAY)}</h2>
          <span class="hint">${isWorkday(TODAY) ? '工作日' : '非工作日'} · 今日待办 ${doneN}/${list.length}</span>
          <div class="spacer"></div>
          <span class="mini">按优先级与时间排序</span>
        </div>
        <form class="split" id="quickForm" style="margin-bottom:10px">
          <input id="qTitle" placeholder="新建临时任务，回车即创建…" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:12.5px;outline:none"/>
          <input type="time" id="qTime" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12.5px"/>
          <button class="btn primary" type="submit">+ 临时任务</button>
        </form>
        <div class="tlist">
          ${list.length ? list.map(o => taskRow(o.t, o.step, o.si)).join('') : '<div class="empty">今天还没有安排，先加一条临时任务？</div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h2>下属常规工作推进</h2><span class="hint">${BOARD_LABEL}完成 ${pendingDone}/${pendingTotal}${BOARD_DAY !== TODAY ? ` · 按 ${fmt(BOARD_DAY)}（下一个工作日）` : ''}</span>
          <div class="spacer"></div><button class="btn sm ghost" data-act="go" data-view="assign">查看全部</button></div>
        ${S.members.length ? `<table>
          <thead><tr><th>成员</th><th>${BOARD_LABEL}完成</th><th>本周达成率</th><th>异常提醒</th></tr></thead>
          <tbody>
            ${S.members.map(m => `<tr>
              <td><b>${esc(m.name)}</b> <span class="mini">${esc(m.role)}</span></td>
              <td>${m.todayTotal ? `${m.todayDone}/${m.todayTotal} <span class="mini">${m.todayDone === m.todayTotal ? '已清' : '待推进'}</span>` : `<span class="mini">${BOARD_LABEL}无节点</span>`}</td>
              <td><div style="display:flex;align-items:center;gap:8px"><div class="prog" style="width:70px"><i class="${m.weekRate >= 80 ? 'g' : ''}" style="width:${m.weekRate}%"></i></div><span class="mini">${m.weekRate}%</span></div></td>
              <td>${m.alert ? `<span class="tag warn">${esc(m.alert)}</span>` : '<span class="mini">—</span>'}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<div class="empty">你还没有直接下属。下属的汇报关系由对方登录时自选，也可在「设置」里维护花名册。</div>`}
      </div>
    </div>

    <div>
      <div class="grid-2" style="grid-template-columns:1fr 1fr;gap:10px">
        ${statCard('todo', '待开展', cnt.todo)}
        ${statCard('doing', '进行中', cnt.doing)}
        ${statCard('done', '已完成', cnt.done)}
        ${statCard('paused', '暂缓', cnt.paused)}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-h"><h2>待接收上级任务</h2><div class="spacer"></div>
          <span class="pill warn">${pending.length} 项</span></div>
        ${pending.length ? pending.map(i => `<div class="kv"><span>${esc(i.title)}</span><b>${fmt(i.due)} 前</b></div>`).join('')
      : '<div class="empty">暂无待接收任务</div>'}
        <button class="btn sm" style="margin-top:10px;width:100%" data-act="go" data-view="intake">进入任务承接台</button>
      </div>
      <div class="card">
        <div class="card-h"><h2>3 天内到期</h2><span class="hint">${soon.length} 项</span></div>
        ${soon.length ? soon.slice(0, 5).map(t => `<div class="kv"><span>${cut(t.title, 12)}</span><b class="${diffDays(t.end, TODAY) <= 1 ? '' : 'mini'}">${fmt(t.end)}</b></div>`).join('')
      : '<div class="empty">暂无临期任务</div>'}
      </div>
      <div class="card">
        <div class="card-h"><h2>快捷入口</h2></div>
        <div class="stack">
          <button class="btn" data-act="new" data-type="assign">下发新任务给组员</button>
          <button class="btn" data-act="new" data-type="special">新建专项（含阶段计划）</button>
          <button class="btn" data-act="new-rule">新建常规工作规则</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============ 视图：任务制定 ============ */
function viewAssign() {
  const list = S.tasks.filter(t => t.type === 'assign' && t.ownerNo === S.me.no);
  const doing = list.filter(t => t.status === 'doing').length;
  const late = list.filter(overdue).length;
  return `
  ${noMgrBar('下发任务')}
  <div class="grid-4">
    ${statCard('', '已下发任务', list.length)}
    ${statCard('doing', '进行中', doing)}
    ${statCard('done', '已完成', list.filter(t => t.status === 'done').length)}
    ${statCard('paused', '逾期未完成', late)}
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-h"><h2>我下发的任务</h2><span class="hint">执行人是组员，因此不进你的日历；在这里看阶段进度与达成标准</span>
      <div class="spacer"></div>
      <button class="btn primary sm" data-act="new" data-type="assign">+ 新建下发任务</button></div>
    ${list.length ? `<table>
      <thead><tr><th style="width:30%">任务</th><th>承接人</th><th>起止</th><th>阶段进度</th><th>达成标准</th><th>状态</th><th></th></tr></thead>
      <tbody>
      ${list.map(t => {
        const p = taskProg(t);
        return `<tr>
          <td style="max-width:250px"><b>${esc(t.title)}</b><div class="mini">${catName(t.cat1, t.cat2)} ${prioLabel(t) ? '· ' + prioLabel(t) : ''}</div></td>
          <td style="white-space:nowrap">${esc(nameOf(t.assigneeNo))}${t.intakeStatus === 'pending' ? ' <span class="tag">待接收</span>' : ''}</td>
          <td class="mini" style="white-space:nowrap">${fmt(t.start)} → ${fmt(t.end)}${overdue(t) ? ' <span class="tag red">逾期</span>' : ''}</td>
          <td><div style="display:flex;align-items:center;gap:8px;white-space:nowrap"><div class="prog" style="width:56px"><i class="${p === 100 ? 'g' : ''}" style="width:${p}%"></i></div><span class="mini">${p}%${t.stages && t.stages.length ? ` · ${t.stages.filter(s => s.done).length}/${t.stages.length} 阶段` : ''}</span></div></td>
          <td class="mini" style="max-width:200px;min-width:140px">${esc(cut(t.std || '未填写', 26))}</td>
          <td>${stTag(t.status)}</td>
          <td><button class="btn sm ghost" data-act="open" data-id="${t.id}">管理</button></td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>` : '<div class="empty">还没有下发过任务</div>'}
  </div>

  <div class="card">
    <div class="card-h"><h2>下属常规工作推进情况</h2>
      <span class="hint">默认折叠为一行汇总，点成员展开；「关注」某一条后，能看到它的完整节点</span>
      <div class="spacer"></div><span class="mini">已关注 ${(S.watch || []).length} 条</span></div>
    <div>${S.members.length ? S.members.map(memberBlock).join('') : '<div class="empty">暂无直接下属</div>'}</div>
    <div class="note" style="margin-top:2px">关注只是你本人的视图偏好：不通知下属、不改他们的任何数据。规则与节点的编辑权始终在本人手里，你只能看状态。</div>
  </div>`;
}

/* ============ 下属常规工作：折叠 / 关注 / 当前节点 ============ */
function isWatched(subNo, rid) { return (S.watch || []).some(w => w.subNo === subNo && w.ruleId === rid); }
function curNodeOf(r) { return (r.nodes || []).find(n => !n.done) || null; }
function cycleCN(c) { return c === 'day' ? '每天' : c === 'week' ? '每周' : '每月'; }
function routineLineHTML(m, r) {
  const w = isWatched(m.no, r.id);
  const nodes = r.nodes || [];
  const multi = nodes.length > 1;
  const cur = curNodeOf(r);
  const late = cur && cur.date < TODAY;
  const curChip = multi
    ? `<span class="curnode ${late ? 'warn' : ''}">${cur
      ? (late ? '卡在：' : '当前：') + esc(cur.name || '节点') + ' · ' + fmt(cur.date) + (late ? ' 逾期' + Math.abs(diffDays(cur.date, TODAY)) + '天' : '')
      : '本轮全部完成'}</span>`
    : `<span class="rmeta">最近完成 ${r.lastDone ? fmt(r.lastDone) : '—'}</span>`;
  return `<div class="rline ${w ? 'open' : ''}">
    <span class="rnm">${esc(r.title)}${multi ? ` <span class="mini">${nodes.length} 节点</span>` : ''}</span>
    <span class="rmeta">${cycleCN(r.cycle)} · 本周 ${r.weekDone}/${r.weekTotal}</span>
    ${curChip}
    <span class="tag-watch ${w ? '' : 'off'}" data-act="watch" data-m="${m.no}" data-r="${r.id}"
      title="${w ? '取消关注，折叠该条' : '关注后展开节点明细'}">${w ? '★ 已关注' : '☆ 关注'}</span>
  </div>` + (w && nodes.length ? `<div class="mnode">${nodes.map(n =>
    `<div class="nl ${n.done ? 'done' : ''} ${n === cur ? 'cur' : ''}"><span class="dot"></span>
      ${esc(n.name || '执行')} · ${fmt(n.date)} · ${n.done ? '已完成' : (n === cur ? '进行中' : '未开始')}</div>`).join('')}</div>` : '');
}
function memberBlock(m) {
  const open = !!openMembers[m.no];
  const wc = (m.routines || []).filter(r => isWatched(m.no, r.id)).length;
  return `<div class="memrow ${open ? 'open' : ''}" data-act="memrow" data-id="${m.no}">
    <div class="ava3">${esc(m.name.slice(-1))}</div>
    <div class="mwho"><b>${esc(m.name)}</b> <span class="mini">${esc(m.role)}</span></div>
    <span class="rmeta">${BOARD_LABEL} ${m.todayDone}/${m.todayTotal}</span>
    <div class="prog" style="width:62px"><i class="${m.weekRate >= 80 ? 'g' : ''}" style="width:${m.weekRate}%"></i></div>
    <span class="mini">${m.weekRate}%</span>
    ${m.alert ? `<span class="tag warn">${esc(m.alert)}</span>` : '<span class="mini">正常</span>'}
    ${wc ? `<span class="tag-watch">★ ${wc}</span>` : ''}
    <span class="mini" style="white-space:nowrap">${open ? '收起 ▴' : '展开 ▾'}</span>
  </div>` + (open ? `<div class="mem-slot">${(m.routines || []).length ? m.routines.map(r => routineLineHTML(m, r)).join('') : '<div class="mini">这位同事还没有设立常规工作</div>'}</div>` : '');
}

/* ============ 视图：常规工作 ============ */
function policyText(p) {
  return p === 'prev' ? '提前至前一工作日' : p === 'next' ? '顺延至后一工作日' : '非工作日跳过';
}
function nodeDayText(r, s) {
  if (r.cycle === 'day') return '每天';
  if (r.cycle === 'week') return '周' + DOW_CN[Number(s.weekday != null ? s.weekday : 1)];
  return (Number(s.mo) ? '次月' : '') + Number(s.day || 1) + '日';
}
function isCrossMonth(r) {
  if (r.cycle !== 'month') return false;
  return (r.steps || []).some(s => Number(s.mo || 0) > 0);
}
function cycleLabel(r) {
  return r.cycle === 'day' ? '每天' : r.cycle === 'week' ? '每周' : '每月';
}
function viewRoutine() {
  const rules = S.rules.filter(r => r.cycle === routineTab);
  const mS = monthStart(TODAY), mE = monthEnd(TODAY);
  return `
  <div class="card">
    <div class="card-h"><h2>常规工作规则</h2><span class="hint">一个周期可以只有一个节点，也可以是一组节点（如每月薪酬工作）</span>
      <div class="spacer"></div><button class="btn primary sm" data-act="new-rule">+ 新建常规工作</button></div>
    <div class="tabs">
      <button class="${routineTab === 'day' ? 'on' : ''}" data-act="rtab" data-tab="day">日常规</button>
      <button class="${routineTab === 'week' ? 'on' : ''}" data-act="rtab" data-tab="week">周常规</button>
      <button class="${routineTab === 'month' ? 'on' : ''}" data-act="rtab" data-tab="month">月常规</button>
    </div>
    ${rules.length ? rules.map(r => {
      const steps = r.steps && r.steps.length ? r.steps : [{ name: '', day: r.day, weekday: r.weekday, time: r.time }];
      const inst = S.tasks.filter(t => t.routineId === r.id && t.planDate >= mS && t.planDate <= mE);
      const doneSteps = inst.reduce((a, t) => a + (t.stages || []).filter(s => s.done).length + (!(t.stages || []).length ? (t.status === 'done' ? 1 : 0) : 0), 0);
      const sortedInst = inst.slice().sort((a, b) => a.start < b.start ? -1 : 1);
      const liveInst = sortedInst.filter(t => t.status !== 'done' && t.end >= TODAY)[0] || sortedInst[sortedInst.length - 1];
      const liveRange = liveInst ? { start: liveInst.start, end: liveInst.end } : null;
      let nodes = [];
      if (r.cycle === 'month') {
        if (liveInst && liveInst.stages && liveInst.stages.length) {
          nodes = liveInst.stages.map(st => {
            const rs = steps.find(x => (x.name || '') === (st.name || '')) || null;
            return {
              s: { name: st.name, time: st.time, day: rs ? rs.day : null, mo: rs ? rs.mo : st.mo },
              plan: st.plan || st.date, actual: st.date, skip: false,
              label: rs ? nodeDayText(r, rs) : fmt(st.date)
            };
          });
        } else {
          nodes = steps.map(s => {
            const plan = stepPlanDate(r, s, { from: mS, anchor: mS });
            const pol = s.policy || r.policy || 'prev';
            const skip = !isWorkday(plan) && pol === 'none';
            return { s, plan, actual: skip ? null : shiftDay(plan, pol), skip, label: nodeDayText(r, s) };
          });
        }
      }
      return `<div class="rule-card">
        <div class="card-h" style="margin-bottom:6px">
          <h2>${esc(r.title)}</h2>
          <span class="chip routine">${cycleLabel(r)}${steps.length > 1 ? ` · ${steps.length} 个节点` : ''}</span>
          ${isCrossMonth(r) ? `<span class="tag warn" title="节点跨到次月，周期区间为「本月 28 日 → 次月 15 日」这类">跨月</span>` : ''}
          ${steps.length === 1 ? `<span class="tag">${r.cycle === 'day' ? '仅工作日' : policyText(r.policy || 'prev')}</span>` : ''}
          <div class="spacer"></div>
          <span class="mini">${catName(r.cat1, r.cat2)}</span>
          <button class="btn sm ghost" data-act="rule-edit" data-id="${r.id}">编辑</button>
          <button class="btn sm ghost" data-act="rule-toggle" data-id="${r.id}">${r.active ? '停用' : '启用'}</button>
          <button class="btn sm ghost" data-act="rule-del" data-id="${r.id}">删除</button>
        </div>
        ${nodes.length ? `<div style="margin:6px 0 4px">
          ${nodes.map(n => `<div class="node">
            <div class="nd">${n.label || nodeDayText(r, n.s)} ${n.s.time || ''}</div>
            <div class="nn"><b>${esc(n.s.name || '执行')}</b>
              <span class="mini">· ${n.skip ? '本次遇节假日，跳过' : `${fmt(n.plan)}${n.actual !== n.plan ? `<span class="chg">（改到 ${fmt(n.actual)}）</span>` : ''}`}</span>
            </div>
          </div>`).join('')}
        </div>` : `<div class="split" style="margin:6px 0">
          ${inst.slice(0, 10).sort((a, b) => a.planDate < b.planDate ? -1 : 1).map(t => `<span class="tag ${t.status === 'done' ? 'done' : ''}" data-act="open" data-id="${t.id}" style="cursor:pointer">
            ${(t.stages || []).length ? t.stages.map(s => fmt(s.date)).join(' / ') : fmt(t.planDate)}${t.planDate !== t.start && !(t.stages || []).length ? `<span style="color:#b45309"> → ${fmt(t.start)}</span>` : ''}${t.status === 'done' ? ' ✓' : ''}
          </span>`).join('') || '<span class="mini">本月无实例</span>'}
        </div>`}
        ${liveRange ? `<div class="mini" style="color:var(--ink2)">本周期：<b>${fmt(liveRange.start)}${liveRange.start === liveRange.end ? '' : ' → ' + fmt(liveRange.end)}</b>${isCrossMonth(r) ? ' <span class="tag warn">跨月</span>' : ''}</div>` : ''}
        <div class="mini">本月：${inst.length} 个周期实例 · ${doneSteps} 个节点已完成${!r.active ? ' · <span style="color:#b45309">已停用：今后不再生成，今天及以前保留</span>' : ''}</div>
      </div>`;
    }).join('') : '<div class="empty">这一类还没有常规工作，点右上角新建</div>'}
  </div>
  <div class="card">
    <div class="card-h"><h2>规则说明</h2></div>
    <div class="note">
      · 常规工作是「规则」不是任务：设定周期和节点后，系统按周期生成实例，进入日历与今日待办。<br/>
      · 一个周期可以挂多个节点，每个节点可单独设月份（本月 / 次月）、日期、时间与节假日策略。<br/>
      · 跨月周期：节点可以落到次月，一个周期就横跨两个月（如 10/28 → 11/15），卡片上标「跨月」并显示本周期区间。<br/>
      · 节假日：逢法定假日或周末，按节点策略「提前至前一工作日」或「顺延至后一工作日」，也可选择跳过。<br/>
      · 规则可以编辑：保存后重排本月及以后、尚未完成的周期，历史周期与已完成的不动；已勾选的节点会按名称保留。日历里拖动节点只改「本次」，规则本身不变。<br/>
      · 停用：今后的周期不再生效——<b>今天及以前的安排原样保留</b>（做过的不清、正在做的不打断），明天以后的自动撤掉；点「启用」即恢复生成。<br/>
      · 删除：这条常规连同它的全部安排一起清掉，日历里不再留任何痕迹。<br/>
      · 实例由服务端统一生成，不依赖谁打开了页面；同事那边看到的就是同一份数据。
    </div>
  </div>`;
}

/* ============ 视图：专项工作 ============ */
function viewSpecial() {
  const list = S.tasks.filter(t => t.type === 'special' && t.ownerNo === S.me.no);
  return `
  <div class="card">
    <div class="card-h"><h2>我的专项工作</h2><span class="hint">非常规、可拆分阶段，自己定开始与结束</span>
      <div class="spacer"></div><button class="btn primary sm" data-act="new" data-type="special">+ 新建专项</button></div>
    ${list.length ? `<div class="grid-2" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      ${list.map(t => {
        const p = taskProg(t);
        const left = diffDays(t.end, TODAY);
        return `<div class="rule-card">
          <div class="card-h" style="margin-bottom:6px">
            <h2>${esc(t.title)}</h2>${stTag(t.status)}${prioBadge(t)}
            ${t.status !== 'done' && left < 0 ? '<span class="tag red">逾期 ' + Math.abs(left) + ' 天</span>' : t.status !== 'done' && left <= 3 ? '<span class="tag warn">剩 ' + left + ' 天</span>' : ''}
            <div class="spacer"></div><button class="btn sm ghost" data-act="open" data-id="${t.id}">管理</button>
          </div>
          <div class="mini" style="margin-bottom:8px">${fmt(t.start)} → ${fmt(t.end)} · ${catName(t.cat1, t.cat2)}${t.stages && t.stages.length ? ' · ' + t.stages.length + ' 个阶段' : ''}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <div class="prog" style="flex:1"><i class="${p === 100 ? 'g' : ''}" style="width:${p}%"></i></div>
            <span class="mini">${p}%</span>
          </div>
          ${t.stages && t.stages.length ? t.stages.map((s, i) => `<div class="stage ${s.done ? 'on' : ''}">
            <div class="n">${s.done ? '✓' : i + 1}</div>
            <div class="t ${s.done ? 'done' : ''}">${esc(s.name)}<small>${fmt(s.start)} → ${fmt(s.end)}</small></div>
          </div>`).join('') : '<div class="mini">还没有阶段，进入详情可拆分阶段计划</div>'}
        </div>`;
      }).join('')}
    </div>` : '<div class="empty">还没有专项工作</div>'}
  </div>`;
}

/* ============ 视图：任务承接台 ============ */
function viewIntake() {
  const pending = S.intake;
  const accepted = acceptedList();
  return `
  ${noMgrBar('任务承接台')}
  <div class="grid-2">
    <div class="card">
      <div class="card-h"><h2>待接收的上级任务</h2><span class="hint">接收 → 规划 → 拆分 → 移入专项 / 临时</span>
        <div class="spacer"></div><span class="pill warn">${pending.length} 项待处理</span></div>
      ${pending.length ? pending.map(i => `<div class="rule-card">
        <div class="card-h" style="margin-bottom:6px"><h2>${esc(i.title)}</h2>
          <span class="tag">${esc(i.from)}</span><div class="spacer"></div><span class="tag red">${fmt(i.due)} 前</span></div>
        <div class="mini" style="margin-bottom:4px">达成标准：${esc(i.std || '未填写')}</div>
        <div class="split"><button class="btn primary sm" data-act="intake-plan" data-id="${i.id}">规划并承接</button>
          <button class="btn sm" data-act="intake-done" data-id="${i.id}">直接办理（留在当前任务里）</button></div>
      </div>`).join('') : '<div class="empty">没有待接收任务，去干自己的事吧</div>'}
    </div>
    <div>
      <div class="card">
        <div class="card-h"><h2>已承接</h2><span class="hint">${accepted.length} 项</span></div>
        ${accepted.length ? accepted.map(t => `<div style="padding:8px 0;border-bottom:1px dashed var(--line2)">
          <div class="split"><b style="font-size:12.5px">${esc(t.title)}</b><span class="tag done">${TYPES[t.type].name}</span></div>
          <div class="mini" style="margin-top:4px">来源：${esc((S.tasks.find(x => x.id === t.sourceId) || {}).title || '上级任务')}（${esc(nameOf((S.tasks.find(x => x.id === t.sourceId) || {}).ownerNo))}）<br/>${fmt(t.start)} → ${fmt(t.end)}</div>
        </div>`).join('') : '<div class="empty">还没有承接记录</div>'}
      </div>
      <div class="card">
        <div class="card-h"><h2>为什么要有这一页</h2></div>
        <div class="note">
          上级下派的任务不直接变成待办，先落到承接台做一次「规划动作」：<br/>
          · 判断这件事是我的专项（长期、要自己推进），还是临时任务（一次性、当天处理）；<br/>
          · 需要组员参与时，直接转成下发任务并指定承接人；<br/>
          · 承接后保留与上级任务的关联，进展可回溯，不用在群里反复问。
        </div>
      </div>
    </div>
  </div>`;
}

/* ============ 视图：日历 ============ */
function calCells() {
  if (calMode === 'week') {
    const start = weekStart(selDay);
    return Array.from({ length: 7 }, (_, i) => ({ d: addDays(start, i), in: true }));
  }
  const first = calCursor, lead = (dow(first) + 6) % 7;
  const start = addDays(first, -lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = addDays(start, i);
    return { d, in: d.slice(0, 7) === calCursor.slice(0, 7) };
  });
}
function cellHTML(c) {
  const d = c.d, items = sortOcc(occOn(d, 'ends'));
  const cls = ['cell'];
  if (!c.in) cls.push('out');
  if (d === TODAY) cls.push('today');
  if (isHoliday(d)) cls.push('holiday');
  else if (!isWorkday(d)) cls.push('weekend');
  const chips = items.slice(0, 4).map(o => {
    const t = o.t, st = o.step;
    const label = st && st.name ? st.name : t.title;
    const drag = JSON.stringify({ id: t.id, s: o.si });
    const adjusted = st ? false : (t.auto && t.planDate !== t.start);
    return `<span class="chip cal ${t.type} ${adjusted ? 'adjusted' : ''} ${st && st.done ? 'donechip' : ''}"
      draggable="true" data-drag='${drag}' data-act="open" data-id="${t.id}" title="${esc(t.title + (st && st.name ? ' · ' + st.name : ''))}">${esc(cut(label, 9))}</span>`;
  }).join('');
  return `<div class="${cls.join(' ')}" data-date="${d}">
    <div class="dhead">
      <span class="num ${dow(d) === 0 ? 'sun' : ''}">${parse(d).getDate()}</span>
      ${d === TODAY ? '<span class="todayb">今天</span>' : ''}
      ${isHoliday(d) ? `<span class="hol">休·${HOL[d]}</span>` : isMakeup(d) ? '<span class="mk">补班</span>' : ''}
    </div>
    ${chips}
    ${items.length > 4 ? `<span class="more">+${items.length - 4}</span>` : ''}
  </div>`;
}
function viewCalendar() {
  const cells = calCells();
  const head = calMode === 'month'
    ? `${parse(calCursor).getFullYear()} 年 ${parse(calCursor).getMonth() + 1} 月`
    : `本周 · ${fmt(cells[0].d)} - ${fmt(cells[6].d)}`;
  const dayItems = sortOcc(occOn(selDay, 'all'));
  return `
  <div class="grid-2">
    <div class="card">
      <div class="cal-head">
        <span class="m">${head}</span>
        <div class="seg">
          <button data-act="cal-mode" data-mode="month" class="${calMode === 'month' ? 'on' : ''}">月</button>
          <button data-act="cal-mode" data-mode="week" class="${calMode === 'week' ? 'on' : ''}">周</button>
        </div>
        <button class="btn sm" data-act="cal-nav" data-step="-1">‹</button>
        <button class="btn sm" data-act="cal-nav" data-step="1">›</button>
        <button class="btn sm ghost" data-act="cal-today">回到今天</button>
        <div class="spacer"></div>
        <span class="mini">拖动卡片到别的日期即可改期</span>
      </div>
      <div class="cal">
        ${['一', '二', '三', '四', '五', '六', '日'].map(x => `<div class="dow">周${x}</div>`).join('')}
        ${cells.map(cellHTML).join('')}
      </div>
      <div class="cal-legend">
        <span><i class="dot" style="background:var(--assign)"></i>任务制定</span>
        <span><i class="dot" style="background:var(--routine)"></i>常规任务</span>
        <span><i class="dot" style="background:var(--special)"></i>专项任务</span>
        <span><i class="dot" style="background:var(--temp)"></i>临时任务</span>
        <span><span class="hol" style="font-size:10px;background:#fde8e8;color:#c0392b;border-radius:4px;padding:0 4px">休</span> 法定节假日</span>
        <span><span class="mk" style="font-size:10px;background:#e8f7f4;color:#0b7a6d;border-radius:4px;padding:0 4px">补班</span> 调休上班</span>
        <span>虚线框 = 常规实例本次改期</span>
      </div>
    </div>
    <div>
      <div class="card">
        <div class="card-h"><h2>${fmtFull(selDay)}</h2>
          <div class="spacer"></div>
          ${isHoliday(selDay) ? '<span class="pill warn">法定假日</span>' : isMakeup(selDay) ? '<span class="pill green">补班</span>' : isWorkday(selDay) ? '<span class="pill">工作日</span>' : '<span class="pill">周末</span>'}
        </div>
        <div class="tlist">
          ${dayItems.length ? dayItems.map(o => taskRow(o.t, o.step, o.si)).join('') : '<div class="empty">这一天还没有安排</div>'}
        </div>
        <button class="btn sm" style="margin-top:10px;width:100%" data-act="new-day">+ 在这一天加临时任务</button>
      </div>
      <div class="card">
        <div class="card-h"><h2>今日待办（可拖到日历）</h2></div>
        <div class="stack">
          ${todayTasks().map(o => `<span class="chip cal ${o.t.type}" draggable="true" data-drag='${JSON.stringify({ id: o.t.id, s: o.si })}' data-act="open" data-id="${o.t.id}">${esc(cut(o.step && o.step.name ? o.t.title + ' · ' + o.step.name : o.t.title, 18))}</span>`).join('') || '<span class="mini">今天没有待办</span>'}
        </div>
        <div class="note" style="margin-top:12px">拖到某一天：普通任务整体平移起止日期；常规实例只调整本次，规则不变。</div>
      </div>
    </div>
  </div>`;
}

/* ============ 视图：设置 ============ */
function viewSettings() {
  const holCfg = {};
  Object.keys(HOL).forEach(d => {
    const n = HOL[d];
    if (!holCfg[n]) holCfg[n] = { from: d, to: d };
    if (d < holCfg[n].from) holCfg[n].from = d;
    if (d > holCfg[n].to) holCfg[n].to = d;
  });
  const mks = Object.keys(MK).sort();
  return `
  <div class="card" style="margin-bottom:14px">
    <div class="card-h"><h2>账号与汇报关系</h2><span class="hint">一期：工号 + 姓名登录，免密码；一个直属上级</span>
      <div class="spacer"></div><button class="btn sm" data-act="switch-user">修改上级</button></div>
    <div class="authkv">
      <div><span>登录账号</span><b>${S.me ? esc(S.me.name) + ' · ' + esc(S.me.no) : '未登录'}</b></div>
      <div><span>部门 / 岗位</span><b>${S.me ? esc(S.me.dept) + ' · ' + esc(S.me.role) : '—'}</b></div>
      <div><span>直属上级</span><b>${S.me && S.me.mgr ? esc(S.me.mgr.name) + ' · ' + esc(S.me.mgr.no) : '<span style="color:#b45309">未设置，下发与承接不可用</span>'}</b></div>
      <div><span>可见范围</span><b>直接下属 ${S.subs.length} 人（向下 1 层）</b></div>
    </div>
    <div class="note" style="margin-top:10px">一个账号只有一个直属上级；防环校验会拒绝选择自己或自己的下级。改上级后，已下发的任务仍保留原上级可见，新增任务只对新上级可见。</div>
  </div>
  <div class="grid-2">
    <div class="card">
      <div class="card-h"><h2>任务分类（两级，管理者自行维护）</h2>
        <div class="spacer"></div><button class="btn sm" data-act="cat-add1">+ 一级分类</button></div>
      ${S.cats.map(c => `<div style="padding:10px 0;border-bottom:1px dashed var(--line2)">
        <div class="split" style="margin-bottom:6px">
          <b>${esc(c.name)}</b><span class="mini">${(c.children || []).length} 个二级</span>
          <div class="spacer"></div>
          <button class="btn sm ghost" data-act="cat-add2" data-id="${c.id}">+ 二级</button>
          <button class="btn sm ghost" data-act="cat-del" data-id="${c.id}">删除</button>
        </div>
        <div class="split">${(c.children || []).map(k => `<span class="tag">${esc(k.name)}
          <span style="cursor:pointer;color:#b6bcc8" data-act="cat-del2" data-id="${c.id}" data-cid="${k.id}">×</span></span>`).join('') || '<span class="mini">暂无二级分类</span>'}</div>
      </div>`).join('') || '<div class="empty">还没有分类，先建一级分类</div>'}
      <div class="note" style="margin-top:10px">临时任务创建时默认归入「其他 / 临时事项」，可手动改。</div>
    </div>
    <div>
      <div class="card">
        <div class="card-h"><h2>节假日配置</h2><span class="hint">服务端统一维护，决定「周末/节假日自动提前或顺延」</span></div>
        ${Object.keys(holCfg).map(n => `<div class="kv"><span>${n}</span><b>${fmt(holCfg[n].from)} - ${fmt(holCfg[n].to)}</b></div>`).join('')}
        <div class="kv"><span>调休补班</span><b style="max-width:70%;text-align:right">${mks.map(m => fmt(m)).join('、') || '—'}</b></div>
        <div class="note" style="margin-top:10px">放假安排每年由国务院公布，二期做成后台可维护的表；目前 2026 全年已录入。</div>
      </div>
      <div class="card">
        <div class="card-h"><h2>数据</h2><span class="hint">都在公司这台机器的数据库里</span></div>
        <div class="kv"><span>存储</span><b>SQLite（data/workbench.db）</b></div>
        <div class="kv"><span>多人共享</span><b>是，同一台机器上的数据同一份</b></div>
        <div class="kv"><span>每 7 秒</span><b>自动拉取同事的最新改动</b></div>
        <div class="split" style="margin-top:10px">
          <button class="btn sm" data-act="load-demo">载入示例数据</button>
          <button class="btn sm danger" data-act="reset">清空我的数据</button>
        </div>
        <div class="note" style="margin-top:10px">清空只删「我」的任务、规则、分类与关注，不动花名册与汇报关系，也不影响别人。</div>
      </div>
      <div class="card">
        <div class="card-h"><h2>一期边界（已确认）</h2><span class="hint">评审以这张表为准</span></div>
        <div class="kv"><span>登录</span><b>工号 + 姓名，免密码</b></div>
        <div class="kv"><span>通知</span><b>仅站内，无邮件 / 企微 / 推送</b></div>
        <div class="kv"><span>汇报关系</span><b>自选即生效，不审核</b></div>
        <div class="kv"><span>验收</span><b>不做，不能当绩效依据</b></div>
        <div class="kv"><span>移动端</span><b>不单独适配</b></div>
        <div class="note" style="margin-top:10px">不做推送的代价：使用率靠「管理者周会过进度 + 首屏即今日待办」撑住；全员推广前必须先接企微推送。</div>
      </div>
    </div>
  </div>`;
}

/* ============ 渲染 ============ */
function render() {
  if (!S || !S.me) return;
  renderMe();
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const map = { today: viewToday, assign: viewAssign, routine: viewRoutine, special: viewSpecial, intake: viewIntake, calendar: viewCalendar, settings: viewSettings };
  $('#view').innerHTML = (map[view] || viewToday)();
  $('#pageTitle').textContent = TITLES[view];
  $('#pageSub').textContent = view === 'calendar' ? '任务与待办统一在日历上安排' : '';
  const wd = isWorkday(TODAY);
  $('#workdayPill').textContent = `${fmtFull(TODAY)} · ${wd ? '工作日' : '非工作日'}`;
  $('#workdayPill').className = 'pill ' + (wd ? 'green' : 'warn');
  const n = S.intake.length;
  const badge = $('#intakeBadge');
  badge.style.display = n ? 'inline-block' : 'none';
  badge.textContent = n;
}

function renderMe() {
  const me = S.me;
  if (!me) return;
  $('#meAva').textContent = me.name.slice(-1);
  $('#meName').textContent = me.name;
  $('#meMeta').textContent = `${me.dept} · ${me.role} · ${me.no}`;
  const m = $('#meMgr');
  m.textContent = me.mgr ? '上级：' + me.mgr.name : '上级：未设置 · 点此设置';
  m.style.color = me.mgr ? '' : '#b45309';
}
function noMgrBar(what) {
  if (S.me && S.me.mgr) return '';
  return `<div class="noauth-bar">⚠ 你还没有设置直属上级，「${what}」暂不可用。
    <span class="btn link" data-act="open-mgr">去设置</span></div>`;
}

/* ============ 详情抽屉 ============ */
function openDrawer(id) {
  const t = S.tasks.find(x => x.id === id);
  if (!t) return;
  drawerId = id;
  $('#drawer').innerHTML = drawerHTML(t);
  $('#drawer').classList.add('show');
  $('#overlay').classList.add('show');
}
function closeDrawer() {
  $('#drawer').classList.remove('show');
  $('#overlay').classList.remove('show');
  drawerId = null;
  if (pendingRefresh) { pendingRefresh = false; refresh(true).catch(() => { }); }
}
function drawerHTML(t) {
  const isRoutine = t.type === 'routine';
  const rule = S.rules.find(r => r.id === t.routineId) || null;
  const stOpts = Object.keys(ST).map(k => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${ST[k].name}</option>`).join('');
  const lvOpts = v => `<option value="">未设置</option>` + [3, 2, 1].map(k => `<option value="${k}" ${v === k ? 'selected' : ''}>${LV[k]}</option>`).join('');
  const isMine = t.ownerNo === S.me.no || t.assigneeNo === S.me.no;
  const whoOpts = [`<option value="${S.me.no}" ${t.assigneeNo === S.me.no ? 'selected' : ''}>我</option>`]
    .concat(S.subs.map(m => `<option value="${m.no}" ${t.assigneeNo === m.no ? 'selected' : ''}>${esc(m.name)}</option>`)).join('');
  const cats = catSelectsHTML(t.cat1, t.cat2);
  const canEdit = isMine;

  return `<div class="dh">
      <div style="flex:1">
        <div class="split" style="margin-bottom:6px">${typeChip(t)}${stTag(t.status)}${prioBadge(t)}${overdue(t) ? '<span class="tag red">已逾期</span>' : ''}
          ${t.ownerNo !== S.me.no ? `<span class="tag">${esc(nameOf(t.ownerNo))} 下发</span>` : ''}</div>
        <input id="dTitle" value="${esc(t.title)}" data-field="title" ${canEdit ? '' : 'readonly'}
          style="width:100%;border:1px solid transparent;border-radius:7px;padding:4px 6px;font-size:15px;font-weight:600;font-family:inherit;outline:none"/>
      </div>
      <button class="btn sm ghost" data-act="close">✕</button>
    </div>
    <div class="db">
      ${isRoutine ? `<div class="note" style="margin-bottom:14px">${rule ? `由常规规则「${esc(rule.title)}」自动生成 · 本周期 ${fmt(t.start)} ~ ${fmt(t.end)}
        ${!(t.stages || []).length ? (t.planDate && t.planDate !== t.start ? `<br/>因节假日已调整到 <b>${fmt(t.start)}</b>，<span class="btn link" data-act="stage-restore" data-id="${t.id}">恢复规则日期</span>` : '') : ''}
        <button class="btn link" data-act="rule-edit" data-id="${t.routineId}" style="margin-top:4px">编辑规则</button>`
        : `所属规则「${esc(t.title)}」<b>已删除</b>，这条实例作为保留记录存在 · 不会再有新的 · 本周期 ${fmt(t.start)} ~ ${fmt(t.end)}
        <br/>如需清掉，可在详情底部删除这条任务。`}
      </div>
      ${(t.stages || []).length ? `<div class="field"><label>本周期节点（勾掉即完成）</label>
        <div class="stagelist">
          ${t.stages.map((s, i) => `<div class="sitem">
            <div class="cb ${s.done ? 'on' : ''}" data-act="toggle-step" data-id="${t.id}" data-idx="${i}">${s.done ? '✓' : ''}</div>
            <div class="nm ${s.done ? 'done' : ''}" style="text-decoration:${s.done ? 'line-through' : 'none'}">${esc(s.name || '执行')}
              <small>${fmt(s.date)}${s.time ? ' · ' + s.time : ''}${s.plan && s.plan !== s.date ? ` · 计划 ${fmt(s.plan)}，节假日已调整` : ''}</small></div>
          </div>`).join('')}
        </div></div>` : ''}` : ''}
      <div class="field"><label>状态</label><select data-field="status">${stOpts}</select></div>
      <div class="field"><label>起止时间</label><div class="row">
        <input type="date" value="${t.start}" data-field="start"/>
        <input type="date" value="${t.end}" data-field="end"/>
      </div></div>
      ${isRoutine ? '' : `<div class="field"><label>时间点（可选）</label><input type="time" value="${t.time || ''}" data-field="time"/></div>
      <div class="field"><label>承接人</label><select data-field="assigneeNo">${whoOpts}</select></div>
      <div class="field"><label>达成标准</label><textarea data-field="std" placeholder="写清楚什么算完成">${esc(t.std || '')}</textarea></div>
      ${cats}
      <div class="field"><label>优先级（可选填）</label><div class="row">
        <select data-field="imp">${lvOpts(t.imp).replace('未设置', '重要度：未设置')}</select>
        <select data-field="urg">${lvOpts(t.urg).replace('未设置', '紧急度：未设置')}</select>
      </div></div>`}
      ${t.type === 'special' || t.type === 'assign' ? `<div class="field"><label>阶段目标（拆分后可按阶段核进度）</label>
        ${(t.stages || []).map((s, i) => `<div class="stage ${s.done ? 'on' : ''}">
          <div class="n" data-act="stage-toggle" data-id="${t.id}" data-idx="${i}" style="cursor:pointer">${s.done ? '✓' : i + 1}</div>
          <div class="t ${s.done ? 'done' : ''}"><s style="text-decoration:${s.done ? 'line-through' : 'none'}">${esc(s.name)}</s><small>${fmt(s.start)} → ${fmt(s.end)}</small></div>
          <button class="btn sm ghost" data-act="stage-del" data-id="${t.id}" data-idx="${i}">删</button>
        </div>`).join('') || '<div class="mini" style="margin-bottom:8px">还没有阶段</div>'}
        <div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:10px">
          <input id="sName" placeholder="阶段名称，例如：数据口径确认与取数" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit;margin-bottom:6px"/>
          <div class="row">
            <input type="date" id="sStart" value="${t.start}" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12px"/>
            <input type="date" id="sEnd" value="${t.end}" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12px"/>
            <button class="btn primary sm" data-act="stage-add" data-id="${t.id}">添加阶段</button>
          </div>
        </div>
      </div>` : ''}
      <div class="note" style="margin-bottom:14px">
        ${t.sourceId ? `来源：上级下派任务（${esc((S.tasks.find(i => i.id === t.sourceId) || {}).title || '')}）<br/>` : ''}
        ${t.ownerNo !== S.me.no ? `下发人：${esc(nameOf(t.ownerNo))} · ` : ''}分类 ${catName(t.cat1, t.cat2)} · 进度 ${taskProg(t)}%
      </div>
      ${isRoutine ? '' : `<button class="btn danger" data-act="task-del" data-id="${t.id}">删除这条任务</button>`}
    </div>`;
}
function catSelectsHTML(c1, c2) {
  const cur1 = c1 || (S.cats[0] || {}).id;
  const kids = ((S.cats.find(c => c.id === cur1) || {}).children) || [];
  const cur2 = c2 || (kids[0] || {}).id;
  return `<div class="field"><label>任务分类</label><div class="row">
    <select data-cat1 data-field="cat1">${S.cats.map(c => `<option value="${c.id}" ${c.id === cur1 ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <select data-cat2 data-field="cat2">${kids.map(k => `<option value="${k.id}" ${k.id === cur2 ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}</select>
  </div></div>`;
}
function refreshCat2(root, c1) {
  const sel = root.querySelector('[data-cat2]');
  if (!sel) return;
  const kids = ((S.cats.find(c => c.id === c1) || {}).children) || [];
  sel.innerHTML = kids.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
}
function otherCat() {
  const c = S.cats.find(x => x.name === '其他') || S.cats[S.cats.length - 1];
  if (!c) return { c1: null, c2: null };
  return { c1: c.id, c2: (c.children && c.children[0] || {}).id || null };
}

/* 与服务端一致的日期推算（只用于规则卡片预览与「本次改期」提示） */
function stepPlanDate(rule, s, c) {
  if (rule.cycle === 'day') return c.anchor;
  if (rule.cycle === 'week') {
    const wd = Number(s.weekday != null ? s.weekday : 1);
    return addDays(c.from, (wd + 6) % 7);
  }
  const d = parse(c.from);
  const mo = Number(s.mo || 0);
  const base = new Date(d.getFullYear(), d.getMonth() + mo, 1);
  const dim = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  const day = Math.min(Number(s.day || 1), dim);
  return iso(new Date(base.getFullYear(), base.getMonth(), day));
}
function shiftDay(s, policy) {
  if (policy === 'none') return s;
  if (isWorkday(s)) return s;
  let d = s, i = 0;
  const step = policy === 'next' ? 1 : -1;
  while (!isWorkday(d) && i < 15) { d = addDays(d, step); i++; }
  return d;
}

/* ============ 弹窗 ============ */
function openModal(title, body, onOk, okText) {
  modalOk = onOk;
  $('#modal').className = 'modal';
  $('#modal').innerHTML = `<div class="mh">${esc(title)}</div><div class="mb">${body}</div>
    <div class="mf"><button class="btn" data-act="modal-cancel">取消</button>
    <button class="btn primary" data-act="modal-ok">${okText || '保存'}</button></div>`;
  $('#modalWrap').classList.add('show');
}
function closeModal() {
  $('#modalWrap').classList.remove('show');
  modalOk = null;
  if (pendingRefresh) { pendingRefresh = false; refresh(true).catch(() => { }); }
}

function taskModalBody(type, preset) {
  const today = (preset && preset.date) || TODAY;
  const base = `
  <div class="field"><label>任务名称</label><input id="f_title" placeholder="例如：季度经营分析报告" value="${preset && preset.title ? esc(preset.title) : ''}"/></div>
  <div class="field"><label>任务类型</label><select id="f_type">
    ${['assign', 'special', 'temp'].map(k => `<option value="${k}" ${k === type ? 'selected' : ''}>${TYPES[k].name}</option>`).join('')}
  </select></div>
  <div class="field"><label>承接人</label><select id="f_assignee">
    <option value="${S.me.no}">我</option>
    ${S.subs.map(m => `<option value="${m.no}" ${(preset && preset.assigneeNo === m.no) ? 'selected' : ''}>${esc(m.name)}（${esc(m.role)}）</option>`).join('')}
  </select></div>
  <div class="field"><label>起止时间 / 时间点（可选）</label><div class="row">
    <input type="date" id="f_start" value="${today}" style="flex:1"/>
    <input type="date" id="f_end" value="${today}" style="flex:1"/>
    <input type="time" id="f_time" style="flex:0 0 96px"/>
  </div></div>
  <div class="field"><label>达成标准</label><textarea id="f_std" placeholder="什么算完成，验收看什么">${preset && preset.std ? esc(preset.std) : ''}</textarea></div>
  ${catSelectsHTML(type === 'temp' ? otherCat().c1 : null, type === 'temp' ? otherCat().c2 : null)}
  <div class="field"><label>优先级（可选填，不填不影响使用）</label><div class="row">
    <select id="f_imp"><option value="">重要度</option>${[3, 2, 1].map(k => `<option value="${k}">${LV[k]}</option>`).join('')}</select>
    <select id="f_urg"><option value="">紧急度</option>${[3, 2, 1].map(k => `<option value="${k}">${LV[k]}</option>`).join('')}</select>
  </div></div>`;

  if (type !== 'special') {
    return base + `<div class="note">${type === 'temp' ? '临时任务默认归入「其他 / 临时事项」，起止可只选今天。' : '下发后组员登录即可在「承接台」看到并承接；可后续在详情里加阶段目标。'}</div>`;
  }
  return `<div class="form-grid">
    <div class="form-col">
      <div class="sec-title">基本信息</div>
      ${base}
    </div>
    <div class="form-col">
      <div class="sec-title">阶段计划 <span class="mini">可留空，之后再补</span></div>
      <div id="stageRows">${stageRowHTML(today, today)}</div>
      <button class="btn sm" data-act="mstage-add" style="width:100%">+ 添加阶段</button>
      <div class="note" style="margin-top:10px">每个阶段独立设开始与结束时间；后期在详情里勾掉阶段，进度自动按阶段数计算。</div>
    </div>
  </div>`;
}
function stageRowHTML(s, e) {
  return `<div class="mrow">
    <input class="sname" placeholder="阶段名称，例如：数据口径确认与取数"/>
    <div class="row2">
      <input type="date" class="sst" value="${s}"/>
      <input type="date" class="sen" value="${e}"/>
      <button class="del" data-act="mstage-del" title="删除该阶段">✕</button>
    </div>
  </div>`;
}
function openNewTask(type, preset) {
  const t = type || 'temp';
  if (t === 'assign' && !(S.me && S.me.mgr)) {
    toast('先设置直属上级，才能下发任务');
    authStep = 'mgr'; authPick = null; authKw = ''; authRender();
    return;
  }
  if (t === 'assign' && !S.subs.length) {
    toast('你还没有直接下属，无法下发任务');
    return;
  }
  openModal(`新建${TYPES[t].name}`, taskModalBody(t, preset), () => {
    const title = $('#f_title').value.trim();
    if (!title) { toast('先填任务名称'); return false; }
    const s = $('#f_start').value, e = $('#f_end').value || s;
    if (!s) { toast('请选择开始时间'); return false; }
    if (e < s) { toast('结束时间不能早于开始时间'); return false; }
    const stages = $$('#stageRows .mrow').map(r => {
      const name = r.querySelector('.sname').value.trim();
      if (!name) return null;
      const st = r.querySelector('.sst').value || s;
      let en = r.querySelector('.sen').value || st;
      if (en < st) en = st;
      return { name, start: st, end: en, done: false };
    }).filter(Boolean);
    const typeVal = $('#f_type').value;
    const assigneeNo = $('#f_assignee').value;
    const task = {
      id: uid('t'), type: typeVal, title,
      ownerNo: S.me.no, assigneeNo,
      assignee: assigneeNo === S.me.no ? '我' : nameOf(assigneeNo),
      start: s, end: e, time: $('#f_time').value || '',
      std: $('#f_std').value.trim(), status: 'todo',
      cat1: $('#modal [data-cat1]').value, cat2: $('#modal [data-cat2]').value,
      imp: Number($('#f_imp').value) || null, urg: Number($('#f_urg').value) || null,
      stages, sourceId: preset && preset.sourceId ? preset.sourceId : null,
      intakeStatus: (typeVal === 'assign' && assigneeNo !== S.me.no) ? 'pending' : null,
      routineId: null, planDate: null, detached: false
    };
    S.tasks.push(task);
    if (preset && preset.sourceId) {
      const src = S.tasks.find(i => i.id === preset.sourceId);
      if (src) src.intakeStatus = 'accepted';
    }
    S.intake = buildIntake(); S.members = buildMembers();
    save(); render(); closeModal();
    toast('已创建：' + title);
  }, '创建');
  if (t === 'special') $('#modal').classList.add('wide');
}

let ruleStepsDraft = [];
function stepRowHTMLFor(cycle, s) {
  s = s || {};
  const pol = s.policy || 'prev';
  const polSel = [['prev', '提前'], ['next', '顺延'], ['none', '跳过']].map(([v, n]) =>
    `<option value="${v}" ${pol === v ? 'selected' : ''}>${n}</option>`).join('');
  const nm = `<input class="sname" placeholder="节点名称（可空）" value="${esc(s.name || '')}"/>`;
  const tm = `<input class="stime" type="time" value="${s.time || '09:00'}"/>`;
  const del = `<button class="del" data-act="rstep-del" title="删除节点">✕</button>`;
  if (cycle === 'day') return `<div class="srow noday">${nm}${tm}<select class="spol">${polSel}</select>${del}</div>`;
  if (cycle === 'week') {
    return `<div class="srow">${nm}<select class="sweek">${[1, 2, 3, 4, 5, 6, 0].map(d => `<option value="${d}" ${Number(s.weekday) === d ? 'selected' : ''}>周${DOW_CN[d]}</option>`).join('')}</select>${tm}<select class="spol">${polSel}</select>${del}</div>`;
  }
  const mo = Number(s.mo || 0);
  const moSel = `<select class="smo" title="这个节点落在本月还是次月">
    <option value="0" ${mo === 0 ? 'selected' : ''}>本月</option>
    <option value="1" ${mo === 1 ? 'selected' : ''}>次月</option>
  </select>`;
  return `<div class="srow smonth">${nm}${moSel}<input class="sday" type="number" min="1" max="31" value="${Number(s.day) || 1}"/>${tm}<select class="spol">${polSel}</select>${del}</div>`;
}
function stepLabelFor(cycle) {
  if (cycle === 'day') return `<div class="step-lbl s2" style="grid-template-columns:1fr 96px 88px 26px"><span>节点名称</span><span>时间</span><span>逢非工作日</span><span></span></div>`;
  if (cycle === 'week') return `<div class="step-lbl"><span>节点名称</span><span>周几</span><span>时间</span><span>逢非工作日</span><span></span></div>`;
  return `<div class="step-lbl smonth"><span>节点名称</span><span>月份</span><span>几日</span><span>时间</span><span>逢非工作日</span><span></span></div>`;
}
function renderStepWrap(cycle) {
  const wrap = $('#stepWrap');
  if (!wrap) return;
  wrap.innerHTML = stepLabelFor(cycle) + `<div id="stepRows">${ruleStepsDraft.map(s => stepRowHTMLFor(cycle, s)).join('')}</div>`;
}
function readStepRows() {
  return $$('#stepRows .srow').map(r => {
    const name = r.querySelector('.sname') ? r.querySelector('.sname').value.trim() : '';
    const time = r.querySelector('.stime') ? r.querySelector('.stime').value : '';
    const pol = r.querySelector('.spol') ? r.querySelector('.spol').value : 'prev';
    const dayEl = r.querySelector('.sday');
    const weekEl = r.querySelector('.sweek');
    const moEl = r.querySelector('.smo');
    return {
      name, time, policy: pol,
      day: dayEl ? (Number(dayEl.value) || 1) : null,
      weekday: weekEl ? Number(weekEl.value) : null,
      mo: moEl ? Number(moEl.value) : 0
    };
  });
}
function openRuleModal(rule) {
  const isEdit = !!rule;
  const cycle = rule ? rule.cycle : 'month';
  ruleStepsDraft = rule ? JSON.parse(JSON.stringify(rule.steps && rule.steps.length ? rule.steps : [{ name: '', day: 5, time: '09:00', policy: 'prev' }]))
    : [{ name: '', day: 5, time: '09:00', policy: 'prev' }];
  openModal(isEdit ? '编辑常规工作' : '新建常规工作', `
    <div class="form-grid">
      <div>
        <div class="field"><label>名称</label><input id="r_title" placeholder="例如：月度薪酬工作" value="${rule ? esc(rule.title) : ''}"/></div>
        <div class="field"><label>周期</label><select id="r_cycle">
          <option value="day" ${cycle === 'day' ? 'selected' : ''}>日常规（每个工作日）</option>
          <option value="week" ${cycle === 'week' ? 'selected' : ''}>周常规（每周一次）</option>
          <option value="month" ${cycle === 'month' ? 'selected' : ''}>月常规（每月一次）</option>
        </select></div>
      </div>
      <div>
        ${catSelectsHTML(rule ? rule.cat1 : null, rule ? rule.cat2 : null)}
        <div class="field" id="r_policy_wrap"><label>节点默认策略（单个节点没单独设置时沿用）</label><select id="r_policy">
          <option value="prev" ${!rule || rule.policy === 'prev' ? 'selected' : ''}>提前至前一工作日</option>
          <option value="next" ${rule && rule.policy === 'next' ? 'selected' : ''}>顺延至后一工作日</option>
          <option value="none" ${rule && rule.policy === 'none' ? 'selected' : ''}>非工作日跳过</option>
        </select></div>
        <div class="note" id="r_day_note" style="display:${cycle === 'day' ? 'block' : 'none'};margin-top:6px">日常规按「每个工作日」生成，周末与法定节假日自动跳过，不需要设策略。</div>
      </div>
    </div>
    <div class="sec-title" style="margin-top:4px">本周期要做的事 <span class="mini">一个周期可以只有一个节点，也可以是一组（如薪酬工作的发邮件/交初稿/做分析/发工资）</span></div>
    <div id="stepWrap"></div>
    <button class="btn sm" data-act="rstep-add" style="margin-top:4px">+ 添加节点</button>
    <div class="note" style="margin-top:12px">${isEdit ? '保存后重排「本月及以后、尚未完成」的周期，历史周期与已完成的保留，已勾选的节点按名称恢复。' : '保存后由服务端生成近期实例，进入今日待办与日历；每个节点会单独出现在对应日期。节点可以选「次月」，用来表达跨月周期。'}</div>
  `, () => {
    const title = $('#r_title').value.trim();
    if (!title) { toast('先填名称'); return false; }
    const cy = $('#r_cycle').value;
    let rows = readStepRows();
    if (cy === 'day') rows = [rows[0] || { name: '', time: '09:00', policy: 'prev' }];
    if (cy !== 'day' && !rows.length) { toast('至少要有一个节点'); return false; }
    const data = {
      title, cycle: cy,
      policy: $('#r_policy').value,
      cat1: $('#modal [data-cat1]').value, cat2: $('#modal [data-cat2]').value,
      steps: cy === 'day'
        ? [{ name: rows[0].name, time: rows[0].time, policy: rows[0].policy }]
        : rows.map(r => ({ name: r.name, day: r.day, weekday: r.weekday, mo: r.mo || 0, time: r.time, policy: r.policy })),
      active: true
    };
    if (isEdit) {
      Object.assign(rule, data);
      toast('规则已更新，后续实例已重排');
    } else {
      S.rules.push(Object.assign({ id: uid('r') }, data));
      toast('规则已创建，实例已生成');
    }
    save(); closeModal();
  }, isEdit ? '保存' : '创建');
  $('#modal').classList.add('wide');
  renderStepWrap(cycle);
  if (cycle === 'day') {
    const pw = $('#r_policy_wrap'), dn = $('#r_day_note');
    if (pw) pw.style.display = 'none';
    if (dn) dn.style.display = 'block';
  }
}

function openIntakeModal(id) {
  const it = S.intake.find(i => i.id === id);
  if (!it) return;
  openModal('规划并承接：' + it.title, `
    <div class="note" style="margin-bottom:12px">来源：${esc(it.from)} · 要求 ${fmt(it.due)} 前 · 标准：${esc(it.std || '未填写')}</div>
    <div class="field"><label>这件事在你这儿算什么</label><select id="f_type">
      <option value="special">专项任务（需要自己持续推进，可拆阶段）</option>
      <option value="temp">临时任务（一次性，尽快处理）</option>
      <option value="assign">下发任务（交给组员办）</option>
    </select></div>
    <div class="field"><label>任务名称</label><input id="f_title" value="${esc(it.title)}"/></div>
    <div class="field"><label>承接人</label><select id="f_assignee">
      <option value="${S.me.no}">我</option>
      ${S.subs.map(m => `<option value="${m.no}">${esc(m.name)}</option>`).join('')}
    </select></div>
    <div class="field"><label>起止时间</label><div class="row">
      <input type="date" id="f_start" value="${TODAY}"/>
      <input type="date" id="f_end" value="${it.due}"/>
    </div></div>
    <div class="field"><label>达成标准</label><textarea id="f_std">${esc(it.std || '')}</textarea></div>
    ${catSelectsHTML()}
  `, () => {
    const title = $('#f_title').value.trim();
    if (!title) { toast('先填任务名称'); return false; }
    const type = $('#f_type').value;
    const assigneeNo = $('#f_assignee').value;
    S.tasks.push({
      id: uid('t'), type, title, ownerNo: S.me.no, assigneeNo,
      assignee: assigneeNo === S.me.no ? '我' : nameOf(assigneeNo),
      start: $('#f_start').value, end: $('#f_end').value, std: $('#f_std').value.trim(),
      status: 'todo', cat1: $('#modal [data-cat1]').value, cat2: $('#modal [data-cat2]').value,
      imp: null, urg: null, stages: [], sourceId: it.id,
      intakeStatus: (type === 'assign' && assigneeNo !== S.me.no) ? 'pending' : null
    });
    const src = S.tasks.find(x => x.id === it.id);
    if (src) src.intakeStatus = 'accepted';
    S.intake = buildIntake(); S.members = buildMembers();
    save(); closeModal(); render();
    toast(type === 'special' ? '已转入专项工作' : type === 'temp' ? '已转入临时任务' : '已下发组员');
  }, '承接');
}
function openCatModal(level, parentId) {
  openModal(level === 1 ? '新建一级分类' : '新建二级分类', `
    <div class="field"><label>名称</label><input id="c_name" placeholder="例如：客户与商机"/></div>
    ${level === 2 ? `<div class="note">上级：${esc((S.cats.find(c => c.id === parentId) || {}).name || '')}</div>` : ''}
  `, () => {
    const name = $('#c_name').value.trim();
    if (!name) { toast('先填名称'); return false; }
    if (level === 1) S.cats.push({ id: uid('c'), name, children: [] });
    else {
      const p = S.cats.find(c => c.id === parentId);
      if (p) { p.children = p.children || []; p.children.push({ id: uid('k'), name }); }
    }
    save(); render(); closeModal(); toast('已添加');
  }, '添加');
}

/* ============ 交互动作 ============ */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1900);
}

function moveTask(id, date, si) {
  const t = S.tasks.find(x => x.id === id);
  if (!t) return;
  if (si != null && si >= 0 && (t.stages || [])[si]) {
    const s = t.stages[si];
    if (s.date === date) return;
    s.date = date;
    const ds = t.stages.map(x => x.date).sort();
    t.start = ds[0]; t.end = ds[ds.length - 1];
    save(); render();
    toast(`「${t.title} · ${s.name || '节点'}」本次调整到 ${fmt(date)}`);
    return;
  }
  if (t.start === date && t.end === date) return;
  if (t.type === 'routine') {
    t.start = date; t.end = date;
    toast(`「${t.title}」本次调整到 ${fmt(date)}，规则本身不变`);
  } else {
    const delta = diffDays(date, t.start);
    t.start = addDays(t.start, delta);
    t.end = addDays(t.end, delta);
    toast(`已改期：${fmt(t.start)}${t.start !== t.end ? ' → ' + fmt(t.end) : ''}`);
  }
  save(); render();
}

/* ============ 账号 ============ */
function mgrListHTML(kw) {
  const me = (S && S.me) || {};
  const list = S.roster.filter(p => p.no !== me.no && (!kw || p.name.indexOf(kw) >= 0 || p.no.indexOf(kw) >= 0));
  if (!list.length) return '<div class="empty" style="padding:20px">没有匹配的人，换个关键字</div>';
  return list.map(p => `<div class="mgr-item ${authPick && authPick.no === p.no ? 'on' : ''}" data-act="pick-mgr" data-no="${p.no}">
    <div class="ava2">${esc(p.name.slice(-1))}</div>
    <div class="who"><b>${esc(p.name)}</b><small>${esc(p.dept)} · ${esc(p.role)} · ${esc(p.no)}</small></div>
    <span class="pick" style="opacity:${authPick && authPick.no === p.no ? 1 : 0}">已选</span>
  </div>`).join('');
}
function authRender(msg) {
  $('#auth').classList.add('show');
  const body = $('#authBody');
  if (authStep === 'login') {
    body.innerHTML = `
      <div class="step">STEP 1 / 2 · 身份校验</div>
      <h3>登录</h3>
      <p class="desc">填写工号与姓名，两者需与花名册一致。一期不设密码，仅用于试点期。</p>
      <div class="auth-field"><label>工号</label><input id="a_no" placeholder="例如 1012" value="1012"/></div>
      <div class="auth-field"><label>姓名</label><input id="a_name" placeholder="与花名册一致" value="王磊"/></div>
      <div class="auth-err" id="a_err">${msg || ''}</div>
      <div class="actions"><button class="btn primary" data-act="do-login">进入工作台</button></div>
      <div class="auth-hint">试点花名册：1012 王磊（产品组组长）· 1002 李明 · 1003 陈静 · 1004 王浩 · 1005 赵敏 · 1001 张启明。<br/>
        一期仅站内使用：不做邮件、不做企业微信、不做手机推送。</div>`;
    return;
  }
  body.innerHTML = `
    <div class="step">STEP 2 / 2 · 汇报关系</div>
    <h3>选择你的直属上级</h3>
    <p class="desc">一个账号只有一个直属上级，用于下发任务、承接上级任务与可见范围。可搜索工号或姓名。</p>
    <div class="auth-field" style="margin-bottom:9px"><input id="a_kw" placeholder="搜索工号 / 姓名" value="${esc(authKw)}"/></div>
    <div class="mgr-list" id="mgrList">${mgrListHTML(authKw)}</div>
    <div class="auth-err" id="a_err">${msg || ''}</div>
    <div class="actions">
      <button class="btn ghost" data-act="skip-mgr">暂时跳过</button>
      <button class="btn primary" data-act="confirm-mgr">确定</button>
    </div>
    <div class="auth-hint">暂不设置也能用：今日待办、常规、专项、临时任务、日历都正常；只是「下发任务」和「任务承接台」会锁住。
      ${S && S.me ? `<br/><span style="color:#7b8a9d">当前身份：${esc(S.me.name)} · ${esc(S.me.no)}</span>
      <span class="btn link" data-act="close-auth" style="margin-left:6px">返回工作台</span>` : ''}</div>`;
}
async function doLogin() {
  const no = ($('#a_no').value || '').trim();
  const name = ($('#a_name').value || '').trim();
  if (!no || !name) return authRender('工号和姓名都要填');
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ no, name }) });
    if (!r.ok) return authRender(r.msg || '登录失败');
    localStorage.setItem(ME_KEY, no);
    await loadState();
    authStep = 'mgr'; authPick = null; authKw = '';
    if (S.me.mgr) finishAuth('欢迎回来，' + S.me.name);
    else authRender();
  } catch (e) {
    authRender('连不上服务：' + e.message);
  }
}
async function finishAuth(tip) {
  $('#auth').classList.remove('show');
  render();
  startPolling();
  if (tip) toast(tip);
}

/* ============ 装载 ============ */
async function loadState() {
  const no = localStorage.getItem(ME_KEY);
  if (!no) throw new Error('未登录');
  const st = await api('/api/state?me=' + encodeURIComponent(no));
  adopt(st);
  setSync('ok', '已同步');
}

/* ============ 事件 ============ */
document.addEventListener('click', e => {
  const nav = e.target.closest('.nav-item');
  if (nav) { view = nav.dataset.view; render(); return; }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  const t = id ? S.tasks.find(x => x.id === id) : null;
  switch (act) {
    case 'do-login': doLogin(); break;
    case 'pick-mgr': {
      const p = S.roster.find(x => x.no === el.dataset.no);
      if (p) { authPick = p; authKw = ($('#a_kw') || {}).value || ''; authRender(); }
      break;
    }
    case 'confirm-mgr': {
      if (!authPick) { authRender('先在上面的列表里选一个人'); break; }
      api('/api/setmgr', { method: 'POST', body: JSON.stringify({ me: S.me.no, mgrNo: authPick.no }) })
        .then(r => {
          if (!r.ok) { authRender(r.msg || '设置失败'); return; }
          S.me.mgr = { no: authPick.no, name: authPick.name, role: authPick.role, dept: authPick.dept };
          refresh(true).then(() => finishAuth('已设置直属上级：' + authPick.name));
        })
        .catch(err => authRender('设置失败：' + err.message));
      break;
    }
    case 'skip-mgr':
      finishAuth('已跳过。下发任务与承接台暂不可用，可随时在设置里补');
      break;
    case 'switch-user':
    case 'open-mgr':
      if (S && S.me) { authStep = 'mgr'; authPick = S.me.mgr ? Object.assign({}, S.me.mgr) : null; authKw = ''; authRender(); }
      break;
    case 'close-auth': $('#auth').classList.remove('show'); break;
    case 'logout':
      if (confirm('退出登录？（数据在服务端，不会丢）')) {
        localStorage.removeItem(ME_KEY);
        if (pollTimer) clearInterval(pollTimer);
        location.reload();
      }
      break;
    case 'memrow': openMembers[id] = !openMembers[id]; render(); break;
    case 'watch': {
      const subNo = el.dataset.m, ruleId = el.dataset.r;
      const i = (S.watch || []).findIndex(w => w.subNo === subNo && w.ruleId === ruleId);
      if (i >= 0) S.watch.splice(i, 1);
      else S.watch.push({ id: 'w_' + S.me.no + '_' + subNo + '_' + ruleId, subNo, ruleId });
      save(); render();
      toast(i >= 0 ? '已取消关注，折叠为一行' : '已关注，展开它的节点明细');
      break;
    }
    case 'go': view = el.dataset.view; render(); break;
    case 'open': openDrawer(id); break;
    case 'close': closeDrawer(); break;
    case 'toggle':
      if (t) {
        t.status = t.status === 'done' ? 'todo' : 'done';
        S.members = buildMembers();
        save(); render(); toast(t.status === 'done' ? '已标记完成' : '已恢复为待开展');
      }
      break;
    case 'new': openNewTask(el.dataset.type || 'temp'); break;
    case 'quick-new': openNewTask('temp'); break;
    case 'new-day': openNewTask('temp', { date: selDay }); break;
    case 'new-rule': openRuleModal(); break;
    case 'rtab': routineTab = el.dataset.tab; render(); break;
    case 'rule-toggle': {
      const r = S.rules.find(x => x.id === id);
      if (!r) break;
      r.active = !r.active;
      let dropped = 0;
      if (!r.active) {
        /* 停用 = 今后不再生效：今天及以前的安排保留（做过的、正在做的都在），明天以后的撤掉 */
        const cut = S.tasks.filter(x => x.routineId === r.id && x.status !== 'done' &&
          (x.planDate || x.start) > TODAY);
        dropped = cut.length;
        const gone = new Set(cut.map(x => x.id));
        S.tasks = S.tasks.filter(x => !gone.has(x.id));
      }
      save(); render();
      if (r.active) {
        toast(`已启用「${r.title}」，后续安排按规则继续生成`);
      } else {
        const kept = S.tasks.filter(x => x.routineId === r.id).length;
        toast(dropped
          ? `已停用「${r.title}」，明天起的 ${dropped} 项安排已撤掉；今天及以前的 ${kept} 项保留`
          : `已停用「${r.title}」，今后不再生成；已有的 ${kept} 项保留`);
      }
      break;
    }
    case 'rule-del': {
      /* 删除 = 彻底删除：规则与它的全部安排一起清掉，与「停用」区分开 */
      const r = S.rules.find(x => x.id === id);
      if (!r) break;
      const inst = S.tasks.filter(x => x.routineId === r.id);
      openModal('删除这条常规工作？', `
        <div class="delbox">
          <p>「<b>${esc(r.title)}</b>」以及它在日历里的 <em>${inst.length}</em> 项安排会被一起删掉，删除后不能恢复。</p>
          <p class="mini" style="margin-top:8px">如果只是暂时不做、还想留着之前的记录，请选「取消」，然后点卡片上的「停用」。</p>
        </div>`, () => {
        S.rules = S.rules.filter(x => x.id !== r.id);
        S.tasks = S.tasks.filter(x => x.routineId !== r.id);
        save(); closeModal(); render();
        toast(`已删除「${r.title}」，连同 ${inst.length} 项安排`);
      }, '删除');
      break;
    }
    case 'task-del':
      if (confirm('删除这条任务？')) {
        S.tasks = S.tasks.filter(x => x.id !== id);
        save(); closeDrawer(); render(); toast('已删除');
      }
      break;
    case 'stage-add': {
      if (!t) break;
      const name = $('#sName').value.trim();
      if (!name) { toast('先填阶段名称'); break; }
      const s = $('#sStart').value || t.start, e2 = $('#sEnd').value || s;
      t.stages = t.stages || [];
      t.stages.push({ name, start: s, end: e2, done: false });
      save(); openDrawer(t.id); render(); toast('阶段已添加');
      break;
    }
    case 'stage-toggle': {
      if (!t) break;
      const i = Number(el.dataset.idx);
      t.stages[i].done = !t.stages[i].done;
      if (t.stages.every(s => s.done)) t.status = 'done';
      else if (t.status === 'done') t.status = 'doing';
      S.members = buildMembers();
      save(); openDrawer(t.id); render();
      break;
    }
    case 'stage-del': {
      if (!t) break;
      t.stages.splice(Number(el.dataset.idx), 1);
      save(); openDrawer(t.id); render();
      break;
    }
    case 'stage-restore': {
      if (!t || !t.planDate) break;
      t.start = t.planDate; t.end = t.planDate;
      save(); openDrawer(t.id); render(); toast('已恢复为规则日期');
      break;
    }
    case 'intake-plan': openIntakeModal(id); break;
    case 'intake-done': {
      const it = S.tasks.find(x => x.id === id);
      if (!it) break;
      it.intakeStatus = 'accepted';
      S.intake = buildIntake();
      save(); render(); toast('已接收，留在「今日待办」里直接做');
      break;
    }
    case 'cal-nav': {
      const step = Number(el.dataset.step);
      if (calMode === 'week') { selDay = addDays(selDay, step * 7); calCursor = monthStart(selDay); }
      else {
        const y = parse(calCursor).getFullYear(), m = parse(calCursor).getMonth() + step;
        calCursor = iso(new Date(y, m, 1));
      }
      render();
      break;
    }
    case 'cal-mode': calMode = el.dataset.mode; render(); break;
    case 'cal-today': selDay = TODAY; calCursor = monthStart(TODAY); render(); break;
    case 'cat-add1': openCatModal(1); break;
    case 'cat-add2': openCatModal(2, id); break;
    case 'cat-del':
      if (confirm('删除一级分类及其二级分类？已用该分类的任务会显示为「未分类」。')) {
        S.cats = S.cats.filter(c => c.id !== id); save(); render();
      }
      break;
    case 'cat-del2': {
      const p = S.cats.find(c => c.id === id);
      if (p) { p.children = p.children.filter(k => k.id !== el.dataset.cid); save(); render(); }
      break;
    }
    case 'rule-edit':
      openRuleModal(S.rules.find(x => x.id === id));
      break;
    case 'rstep-add': {
      ruleStepsDraft = $('#stepRows') ? readStepRows() : ruleStepsDraft;
      ruleStepsDraft.push({ name: '', day: 1, time: '09:00', policy: 'prev' });
      renderStepWrap($('#r_cycle').value);
      break;
    }
    case 'rstep-del': {
      const rows = $$('#stepRows .srow');
      const idx = rows.indexOf(el.closest('.srow'));
      ruleStepsDraft = readStepRows();
      ruleStepsDraft.splice(idx, 1);
      if (!ruleStepsDraft.length) ruleStepsDraft = [{ name: '', time: '09:00', policy: 'prev' }];
      renderStepWrap($('#r_cycle').value);
      break;
    }
    case 'mstage-add': {
      const st = ($('#f_start') || {}).value || TODAY;
      const en = ($('#f_end') || {}).value || st;
      $('#stageRows').insertAdjacentHTML('beforeend', stageRowHTML(st, en));
      break;
    }
    case 'mstage-del':
      el.closest('.mrow').remove();
      break;
    case 'toggle-step': {
      if (!t || !(t.stages || []).length) break;
      const i = Number(el.dataset.idx), s2 = t.stages[i];
      if (!s2) break;
      s2.done = !s2.done;
      t.status = t.stages.every(x => x.done) ? 'done' : 'doing';
      S.members = buildMembers();
      save();
      if (drawerId === t.id) openDrawer(t.id);
      render();
      toast(s2.done ? '已完成：' + (s2.name || '节点') : '已恢复为待办');
      break;
    }
    case 'load-demo':
      api('/api/demo', { method: 'POST', body: JSON.stringify({ me: S.me.no }) })
        .then(r => refresh(true).then(() => { render(); toast(r.created ? `已载入 ${r.created} 条示例任务` : '已有数据，未重复载入'); }))
        .catch(e => toast('载入失败：' + e.message));
      break;
    case 'reset':
      if (confirm('清空「我」的任务、常规规则、分类与关注？不影响别人，也不动花名册。')) {
        api('/api/reset', { method: 'POST', body: JSON.stringify({ me: S.me.no }) })
          .then(() => refresh(true).then(() => { render(); toast('已清空'); }))
          .catch(e => toast('清空失败：' + e.message));
      }
      break;
    case 'modal-ok': {
      if (modalOk && modalOk() === false) return;
      break;
    }
    case 'modal-cancel': closeModal(); break;
  }
});

/* 日历拖拽 */
document.addEventListener('dragstart', e => {
  const el = e.target.closest('[data-drag]');
  if (!el) return;
  e.dataTransfer.setData('text/plain', el.dataset.drag);
  e.dataTransfer.effectAllowed = 'move';
  el.classList.add('dragging');
});
document.addEventListener('dragend', e => {
  const el = e.target.closest('[data-drag]');
  if (el) el.classList.remove('dragging');
  $$('.cell.drop-hot').forEach(c => c.classList.remove('drop-hot'));
});
document.addEventListener('dragover', e => {
  const cell = e.target.closest('.cell[data-date]');
  if (!cell) return;
  e.preventDefault();
  cell.classList.add('drop-hot');
});
document.addEventListener('dragleave', e => {
  const cell = e.target.closest('.cell[data-date]');
  if (cell) cell.classList.remove('drop-hot');
});
document.addEventListener('drop', e => {
  const cell = e.target.closest('.cell[data-date]');
  if (!cell) return;
  e.preventDefault();
  cell.classList.remove('drop-hot');
  const raw = e.dataTransfer.getData('text/plain');
  if (!raw) return;
  let id = raw, si = -1;
  try { const o = JSON.parse(raw); id = o.id; si = (o.s == null ? -1 : o.s); } catch (err) { }
  moveTask(id, cell.dataset.date, si);
});

/* 日历点选日期 */
document.addEventListener('click', e => {
  const cell = e.target.closest('.cell[data-date]');
  if (cell && !e.target.closest('[data-drag]')) { selDay = cell.dataset.date; render(); }
});

/* 抽屉内字段编辑 */
document.addEventListener('change', e => {
  const modal = e.target.closest('#modal');
  if (modal && e.target.matches('[data-cat1]')) { refreshCat2(modal, e.target.value); return; }
  if (modal && e.target.id === 'r_cycle') {
    ruleStepsDraft = readStepRows(); renderStepWrap(e.target.value);
    const pw = $('#r_policy_wrap'), dn = $('#r_day_note');
    if (pw) pw.style.display = e.target.value === 'day' ? 'none' : '';
    if (dn) dn.style.display = e.target.value === 'day' ? 'block' : 'none';
    return;
  }
  if (modal && e.target.matches('#f_type')) {
    if (e.target.value === 'temp') toast('临时任务默认归入「其他 / 临时事项」');
    return;
  }
  const dr = e.target.closest('#drawer');
  if (!dr || !drawerId) return;
  const t = S.tasks.find(x => x.id === drawerId);
  if (!t) return;
  const f = e.target.dataset.field;
  if (!f) return;
  if (f === 'cat1') {
    t.cat1 = e.target.value;
    const kids = ((S.cats.find(c => c.id === t.cat1) || {}).children) || [];
    t.cat2 = (kids[0] || {}).id || '';
    save(); openDrawer(t.id); render(); return;
  }
  if (f === 'start' || f === 'end') {
    const v = e.target.value;
    if (!v) return;
    if (f === 'start') { const delta = diffDays(v, t.start); t.start = v; if (t.type !== 'routine') t.end = addDays(t.end, delta); else t.end = v; }
    else { t.end = v; }
    if (t.end < t.start) t.end = t.start;
  } else if (f === 'imp' || f === 'urg') {
    t[f] = e.target.value ? Number(e.target.value) : null;
  } else if (f === 'status') {
    t.status = e.target.value;
  } else if (f === 'title') {
    t.title = e.target.value.trim() || t.title;
  } else if (f === 'assigneeNo') {
    t.assigneeNo = e.target.value;
    t.assignee = t.assigneeNo === S.me.no ? '我' : nameOf(t.assigneeNo);
    if (t.type === 'assign' && t.assigneeNo !== S.me.no && t.ownerNo === S.me.no) t.intakeStatus = 'pending';
  } else {
    t[f] = e.target.value;
  }
  S.members = buildMembers(); S.intake = buildIntake();
  save(); render(); openDrawer(t.id);
});

/* 今日待办快捷新建 */
document.addEventListener('submit', e => {
  if (e.target.id !== 'quickForm') return;
  e.preventDefault();
  const title = $('#qTitle').value.trim();
  if (!title) { toast('先写点什么'); return; }
  const c = otherCat();
  S.tasks.push({
    id: uid('t'), type: 'temp', title, ownerNo: S.me.no, assigneeNo: S.me.no, assignee: '我',
    start: TODAY, end: TODAY, time: $('#qTime').value || '', std: '', status: 'todo',
    cat1: c.c1, cat2: c.c2, imp: null, urg: null, stages: [],
    routineId: null, planDate: null, detached: false, intakeStatus: null
  });
  save(); render(); toast('已加入今日待办');
});

$('#overlay').addEventListener('click', closeDrawer);
$('#modalWrap').addEventListener('click', e => { if (e.target.id === 'modalWrap') closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeDrawer(); closeModal(); }
  if (e.key === 'Enter' && $('#auth').classList.contains('show') && (e.target.id === 'a_no' || e.target.id === 'a_name')) {
    e.preventDefault(); doLogin();
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'a_kw') {
    authKw = e.target.value.trim();
    const box = $('#mgrList');
    if (box) box.innerHTML = mgrListHTML(authKw);
  }
});

/* ============ 启动 ============ */
(async function init() {
  const no = localStorage.getItem(ME_KEY);
  if (!no) { authStep = 'login'; authRender(); return; }
  $('#boot').classList.add('show');
  try {
    await loadState();
    $('#boot').classList.remove('show');
    view = 'today';
    render();
    if (!S.me.mgr) { authStep = 'mgr'; authRender(); }
    startPolling();
  } catch (e) {
    $('#boot').classList.remove('show');
    localStorage.removeItem(ME_KEY);
    authStep = 'login';
    authRender('会话已失效（' + e.message + '），请重新登录');
  }
})();
