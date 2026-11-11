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
/* 带年份的完整日期：只在跨年的提示里用（阶段计划常常跨年，短格式会把 2026 和 2027 看成同一年）。 */
const fmtY = s => { if (!s) return '—'; const d = parse(s); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtFull = s => { const d = parse(s); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${DOW_CN[d.getDay()]}`; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const uid = p => p + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
const monthStart = s => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth(), 1)); };
const monthEnd = s => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
const weekStart = s => addDays(s, -((dow(s) + 6) % 7));

let TODAY = iso(new Date());

/* ============ 节假日（由服务端提供，保证服务端生成实例与前端渲染一致） ============ */
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
  assign: { name: '发布任务', cls: 'assign' },
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
  today: '今日待办', assign: '发布任务', routine: '常规工作', special: '专项工作',
  intake: '任务承接台', calendar: '日历待办', settings: '设置', task: '任务详情'
};

/* ============ 运行状态 ============ */
let S = null;                  /* 视图数据（内存缓存，真相在服务端） */
let REV = 0;
let SNAP = null;               /* 上次同步成功时的自有数据快照，用于算增量 */
let obsSign = {};              /* 每行知情人名单的指纹：只在这份副本动过名单时才提交该字段 */
let syncing = false;
let pendingRefresh = false;
let pollTimer = null;
let view = 'today', calCursor = monthStart(TODAY), calMode = 'month', selDay = TODAY;
/* 从日历上点一条活时，不在日历上弹详情——多半是想改状态。
   记下要定位的那一行（任务 id + 阶段序号），渲染完把右侧清单滚过去并高亮。 */
let focusKey = '';
let routineTab = 'month';
let openMembers = {};
let openSpecialBlock = false;   /* 「下属专项工作推进情况」整块默认收起 */
let modalOk = null;
let authStep = 'login', authPick = null, authKw = '';
/* 管理账号首次登录要先用旧密码换新密码，旧密码只放在内存里，不写 localStorage */
let authOldPwd = '';

const ME_KEY = 'pm_mvp_me';    /* 只存工号，数据一律在服务端 */

/* ============ API ============ */
/* 会话失效统一回登录页：任何一个接口 401，都说明 cookie 没了或过期了。
   这里集中处理，避免每个调用点各写一遍还漏掉。 */
function onAuthLost() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  localStorage.removeItem(ME_KEY);
  S = null;
  REV = 0;
  const boot = $('#boot');
  if (boot) boot.classList.remove('show');
  authStep = 'login';
  authRender('登录已过期，请重新登录');
}
async function api(path, opts) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' }
  }, opts));
  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : {}; } catch (e) { throw new Error('服务返回异常：' + txt.slice(0, 80)); }
  if (res.status === 401) {
    onAuthLost();
    const err = new Error(data.msg || '登录已过期，请重新登录');
    err.status = 401;
    throw err;
  }
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
    me: { no: st.me.no, name: st.me.name, role: st.me.role, dept: st.me.dept, mgr: st.me.mgr || null, admin: !!st.me.admin },
    roster: st.roster || [],
    subs: st.subs || [],
    cats: st.cats || [],
    rules: st.rules || [],
    tasks: st.tasks || [],
    watch: st.watch || [],
    notices: st.notices || [],
    routineMeta: meta,
    members: [],
    intake: []
  };
  S.members = buildMembers();
  S.intake = buildIntake();
  S.stageIntake = buildStageIntake();
  S.noticeGroups = buildNoticeGroups();
  REV = st.rev || 0;
  SNAP = signatures();
}

/* 自有数据签名：用于「改了才发」。
   只算 owner 是我的行——发布人接出去之后是只读，承接台里的动作走专用接口，
   把别人的行塞进 /api/sync 只会换来一句"这条任务已经交出去了"。 */
function ownRows() {
  const me = S.me.no;
  const tasks = S.tasks
    .filter(t => t.ownerNo === me)
    .map(t => ({
      id: t.id, type: t.type, title: t.title, ownerNo: t.ownerNo, assigneeNo: t.assigneeNo,
      dueDate: t.dueDate || t.end,
      start: t.start, end: t.end, time: t.time || '', std: t.std || '', status: t.status,
      cat1: t.cat1 || null, cat2: t.cat2 || null,
      imp: t.imp == null ? null : t.imp, urg: t.urg == null ? null : t.urg,
      stages: t.stages || [], routineId: t.routineId || null, planDate: t.planDate || null,
      sourceId: t.sourceId || null, detached: !!t.detached, intakeStatus: t.intakeStatus || null,
      observers: t.observers || []
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
  const watch = (S.watch || []).map(w => ({
    id: w.id, subNo: w.subNo, ruleId: w.ruleId, kind: w.kind || 'routine', taskId: w.taskId || null
  }));
  return { tasks, rules, cats, watch };
}
function signatures() {
  const own = ownRows();
  const out = {};
  const obs = {};
  for (const k of Object.keys(own)) {
    out[k] = {};
    own[k].forEach(r => {
      out[k][r.id] = JSON.stringify(r);
      if (k === 'tasks') obs[r.id] = JSON.stringify((r.observers || []).slice().sort());
    });
  }
  obsSign = obs;
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
      for (const id of Object.keys(cur)) {
        if (SNAP[k][id] === cur[id]) continue;
        const payload = Object.assign({}, own[k].find(r => r.id === id));
        /* 知情人名单只在「这份副本自己动过名单」时才提交。
           服务端是整体替换，所以打开得更早的那个标签页一保存，就会把别人刚加的人冲掉——
           而它其实只改了标题。没动名单就别带这个字段，服务端按「没提交 ≠ 清空」处理。 */
        if (k === 'tasks') {
          const now = JSON.stringify((payload.observers || []).slice().sort());
          if (obsSign[id] === now) delete payload.observers;
        }
        body[k].push(payload);
      }
      for (const id of Object.keys(SNAP[k])) if (!(id in cur)) body.del[k].push(id);
    }
    const changed = body.tasks.length + body.rules.length + body.cats.length + body.watch.length +
      body.del.tasks.length + body.del.rules.length + body.del.cats.length + body.del.watch.length;
    if (changed) {
      /* 服务端可能拒收某一条（比如发布给一个从没登录过工作台的人）。
         拒了就把原因原话端出来——默默失败会让人以为派出去了。 */
      const r = await api('/api/sync', { method: 'POST', body: JSON.stringify(body) });
      if (r && r.errors && r.errors.length) toast(r.errors[0]);
    }
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
  const st = await api('/api/state');
  const keepView = view;
  adopt(st);
  if (keepView !== view) view = keepView;
  if (!silent) setSync('ok', '已同步');
  if (canRerender()) render();
  else pendingRefresh = true;
}

function canRerender() {
  /* 详情页上有人在打字，别让 7 秒一次的自动刷新把输入清掉 */
  return view !== 'task' && !$('#modalWrap').classList.contains('show') &&
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
    /* 逾期的不只是「派给我但还没接」的：承接过来的专项才算他真在推的活 */
    const lateTask = S.tasks.filter(t => t.ownerNo === sub.no && t.type !== 'routine'
      && t.status !== 'done' && t.end < TODAY).length;
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

/* 承接台三块，装的是三件不同的事，别混：
   ① 等你立项：整件事派给你、还没接 —— 接收 = 所有权转移，一条任务不会变成两条；
   ② 分给你的子任务：承接人理完计划、点了「派发」之后才出现 —— 派发前指定等于没说；
   ③ 有变动：派发之后改期/换人/删除，靠 stage_notice 兜住，没有推送也得让人看见。 */
function buildIntake() {
  return S.tasks
    .filter(t => t.type === 'assign' && t.assigneeNo === S.me.no
      && t.intakeStatus === 'pending' && t.ownerNo !== S.me.no)
    .map(t => ({
      id: t.id, task: t, title: t.title, from: nameOf(t.publisherNo || t.ownerNo),
      due: t.dueDate || t.end, std: t.std
    }));
}
/* 按父任务聚合：一次派 5 段给同一个人，5 张卡是噪音 */
function buildStageIntake() {
  const g = {};
  for (const t of S.tasks) {
    for (const s of (t.stages || [])) {
      if (!s.pid || s.who !== S.me.no || !s.whoAt || s.joinedAt) continue;
      if (!g[t.id]) g[t.id] = { id: t.id, task: t, from: nameOf(t.ownerNo), stages: [] };
      g[t.id].stages.push(s);
    }
  }
  return Object.values(g).map(x => Object.assign(x, {
    earliest: x.stages.map(s => s.start || s.date).filter(Boolean).sort()[0] || x.task.start
  })).sort((a, b) => (a.earliest < b.earliest ? -1 : 1));
}
function buildNoticeGroups() {
  const g = {};
  for (const n of (S.notices || [])) {
    if (!g[n.taskId]) g[n.taskId] = { taskId: n.taskId, items: [] };
    g[n.taskId].items.push(n);
  }
  return Object.values(g).map(x => Object.assign(x, {
    title: (S.tasks.find(t => t.id === x.taskId) || {}).title || '一条任务'
  }));
}
/* 已经移交到我名下的（含 0.5/0.6 时代的派生副本） */
function acceptedList() {
  return S.tasks.filter(t => t.ownerNo === S.me.no &&
    ((t.publisherNo && t.publisherNo !== S.me.no) || t.sourceId));
}

/* ============ 数据查询 ============ */
/* 分类在新建/编辑时手填，存的是文字；早期数据里存的是分类 id，两种都认，
   免得老任务在列表里显示成一串 id。
   还有一种情况：任务被交接给别人之后，身上还挂着上一个人分类树里的 id。
   别的账号的分类树我在本地看不见，也没必要为它多拉一份数据——认不出来的 id
   就当没分类，别把 1012_c2 这种东西印在卡片上。 */
const catLabel = v => {
  if (!v) return '';
  for (const c of S.cats) {
    if (c.id === v) return c.name;
    const k = (c.children || []).find(x => x.id === v);
    if (k) return k.name;
  }
  /* 形如 1004_c12 的内部 id：本机解析不出来就丢弃，人工填的分类名照原样显示 */
  return /^\d+_c\d+$/.test(String(v)) ? '' : String(v);
};
const catName = (c1, c2) => {
  const a = catLabel(c1), b = catLabel(c2);
  if (!a && !b) return '未分类';
  return a ? (b ? a + ' / ' + b : a) : b;
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

/* 日历上出现的应该是一件大事的「哪一段」，不是父任务的名字。
   有阶段的任务（专项 / 发布 / 带节点的常规）按阶段展开：常规节点是单日，
   专项阶段是区间，落在这一段里就显示这一段的名字。
   非工作日（周末 / 法定假日）不铺区间型条目：阶段跨周末只说明计划是连着的，
   不等于周末要干活；明确落在这一天的单日节点照常显示。 */
function occOn(date, mode) {
  const rest = !isWorkday(date);
  const out = [];
  S.tasks.forEach(t => {
    if (!isMineTask(t)) return;
    const stages = t.stages || [];
    if (stages.length) {
      let hit = null;
      stages.forEach((s, i) => {
        if (hit) return;
        /* 父阶段不出条目：它的日期是子任务并集，出了就和子任务同一天撞两条 */
        if (hasKids(stages, s)) return;
        if (rest && !s.date) return;
        const on = s.date ? s.date === date : (s.start && s.end && s.start <= date && s.end >= date);
        if (on) hit = { t, step: s, si: i };
      });
      if (hit) out.push(hit);
      /* 拆过阶段的任务只在阶段上出现，不再退回整条任务：
         常规实例的起止横跨两个月，一退回就会在没排节点的周末凭空冒出一条。 */
      return;
    }
    if (!(t.start <= date && t.end >= date)) return;
    if (rest && t.start !== t.end) return;
    if (mode === 'ends' && t.type !== 'routine' && t.start !== t.end && date !== t.start && date !== t.end) return;
    out.push({ t, step: null, si: -1 });
  });
  return out;
}
function sortOcc(list) {
  const doneOf = o => (o.step ? !!o.step.done : o.t.status === 'done');
  return [...list].sort((a, b) => {
    /* 做完的沉到后面：当天列表从上往下读，应该先看到还没干的 */
    const da = doneOf(a) ? 1 : 0, db = doneOf(b) ? 1 : 0;
    if (da !== db) return da - db;
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
/* ============ 阶段树 ============ */
/* 阶段只允许两级：pid 为空的是阶段，其余是它的子任务。数组保持扁平，靠 pid 指父。
   老数据没有 id/pid，`!s.pid` 对所有节点都成立 —— 所以没拆过子任务的任务，行为与改动前完全一致。 */
const kidsOf = (stages, id) => id ? (stages || []).filter(s => s.pid === id) : [];
const hasKids = (stages, s) => !!s.id && (stages || []).some(x => x.pid === s.id);
/* 叶子 = 没有子任务的节点。进度、日历、完成判定都只认叶子，父阶段是派生的，不参与计数。 */
const leavesOf = stages => (stages || []).filter(s => !hasKids(stages, s));
/* 阶段的起止是**人设定的**，不从子任务反推。子任务只能排在这个窗口里：
   窗口装不下就明确去改阶段，而不是让阶段被悄悄撑长——那样人会以为自己设的时间没生效。
   （曾经有过一版是按子任务并集重算父阶段，导致改阶段自己的日期被静默打回原样。） */
const parentOf = (stages, s) => (s && s.pid ? (stages || []).find(x => x.id === s.pid) : null);
/* 子任务越界的说法：指出它在谁的窗口外、两边各该怎么改 */
function windowMsg(stages, kid, p) {
  const no = topNo(stages, p);
  const ps = dayOf(p, 'start'), pe = dayOf(p, 'end') || ps;
  const ks = dayOf(kid, 'start') || dayOf(kid, 'end');
  const ke = dayOf(kid, 'end') || ks;
  if (ks && ps && ks < ps)
    return `「${kid.name || '这个子任务'}」从 ${fmt(ks)} 起，可第 ${no} 段「${p.name || ''}」是 ${dateSpan(p)}；把这一段提前到 ${fmt(ks)}，或者把它挪到 ${fmt(ps)} 之后`;
  return `「${kid.name || '这个子任务'}」排到 ${fmt(ke)}，可第 ${no} 段「${p.name || ''}」只到 ${fmt(pe)}；把这一段延长到 ${fmt(ke)}，或者把它收到 ${fmt(pe)} 之前`;
}
/* 同层相邻：子任务只和同一父下的兄弟比顺序，顶层阶段只和顶层比。
   按数组下标直接取上一条会把「上一阶段的最后一个子任务」当成相邻段，误报重叠。 */
function siblingsOf(stages, si) {
  const s = stages[si];
  if (!s) return [];
  const pid = s.pid || null;
  return stages.map((x, i) => ({ x, i })).filter(o => (o.x.pid || null) === pid);
}
const dayOf = (s, k) => (s && (s[k] || s.date)) || '';
const topNo = (stages, p) => stages.filter(x => !x.pid).indexOf(p) + 1;
/* 阶段树的展示顺序：每个一级阶段后面紧跟它自己的子任务，编号 1 / 1.1 / 2 / 2.1。
   stages 数组里子任务排在所有一级阶段之后（新增就是 push 到末尾），
   直接按数组顺序编号会把子任务排成 4、5、6，看着像 6 个并列阶段、日期还来回跳。
   父 id 指向不存在的节点时按一级处理，宁可多显示也不要让它凭空消失。 */
function stageRows(stages) {
  const arr = stages || [];
  const isTop = s => !s.pid || !arr.some(x => x.id === s.pid);
  const rows = [];
  let n = 0;
  for (const s of arr) {
    if (!isTop(s)) continue;
    n++;
    rows.push({ s, no: String(n), sub: false });
    let k = 0;
    for (const c of arr) {
      if (c.pid !== s.id) continue;
      if (isTop(c)) continue;      /* 自引用的脏数据不当子任务 */
      k++;
      rows.push({ s: c, no: `${n}.${k}`, sub: true });
    }
  }
  return rows;
}
/* 卡片上那句「N 个阶段 · M 个子任务」：阶段数只数一级，子任务另说。
   以前拿 stages.length 当阶段数，6 个节点报成「6 个阶段」。 */
function stageMeta(t) {
  const arr = (t && t.stages) || [];
  if (!arr.length) return '';
  const tops = arr.filter(s => !s.pid || !arr.some(x => x.id === s.pid)).length;
  const kids = arr.length - tops;
  return ` · ${tops} 个阶段${kids ? ` · ${kids} 个子任务` : ''}`;
}
const dateSpan = s => {
  const a = dayOf(s, 'start'), b = dayOf(s, 'end') || a;
  return a ? (a === b ? fmt(a) : `${fmt(a)}–${fmt(b)}`) : '';
};

/* 同层重叠时的说法：两段都点名、日期带年、给出重叠区间，最后一句告诉人怎么改。
   以前这里只报「前一段占到某天」，年份被短格式抹掉，跨年时看着像同一年撞上了。 */
function overlapMsg(stages, a, b, pid) {
  const as = dayOf(a, 'start') || dayOf(a, 'end');
  const ae = dayOf(a, 'end') || dayOf(a, 'start');
  const bs = dayOf(b, 'start') || dayOf(b, 'end');
  const be = dayOf(b, 'end') || dayOf(b, 'start');
  const no = s => (s.pid ? '子任务' : `第 ${topNo(stages, s)} 段`);
  const who = s => (s.who ? `（${nameOf(s.who)} 做）` : '');
  const os = as > bs ? as : bs, oe = ae < be ? ae : be;
  const span = !os ? '' : (os === oe ? fmtY(os) : `${fmtY(os)} 到 ${fmtY(oe)}`);
  let tail = '';
  if (pid) {
    const p = stages.find(x => x.id === pid);
    if (p) tail = `；第 ${topNo(stages, p)} 段「${p.name || ''}」的窗口是 ${fmtY(dayOf(p, 'start'))} → ${fmtY(dayOf(p, 'end'))}`;
  }
  return `${no(a)}「${a.name || '未命名'}」${who(a)}（${fmtY(as)} → ${fmtY(ae)}）`
    + `和${no(b)}「${b.name || '未命名'}」${who(b)}（${fmtY(bs)} → ${fmtY(be)}）压上了`
    + `${span ? `：${span} 同时算在两段里` : ''}。把其中一段挪开再存${tail}`;
}

/* ============ 阶段校验：唯一入口 ============
   这套规则以前散在 dragCheck 和 stage-save 里，五个写入口（拖拽改期 / 阶段表单 /
   加子任务 / 加顶层阶段 / 删节点）各自只记住了一部分。后果是「没校验的入口能造脏数据，
   有校验的入口改不动」——同一个阶段下两条同名同期的子任务就是这么进来的。
   现在所有入口一律：先把改完之后的完整 stages 算出来（父阶段回算过），交到这里，
   通过了才写回 t.stages。返回 {ok, code, msg}，msg 直接给人看。
   软约束（不排过去、不排周末）留在 dragCheck：那是拖拽的手势才有的问题，
   在表单里填过去的日期是正常操作，不该报错。 */
function validateStages(t, next, ctx) {
  ctx = ctx || {};
  const prev = (t && t.stages) || [];
  const was = {};
  for (const s of prev) if (s && s.id) was[s.id] = s;
  const bad = (code, msg) => ({ ok: false, code, msg });

  /* 只拦「这次改动新造成的问题」。库里可能早就躺着违规数据（比如某次老版本写进去的两段重叠），
     拿它去拦一个与之无关的改名/改期，人看到的是「我什么都没动，你说我错了」，而且怎么改都过不去。
     所以先算清楚这次到底动了谁：新增的、起止变了的、换了父的。判断重叠等约束时，只有涉及到
     这些节点的配对才算数——存量问题留给「数据体检」，不在这儿当路障。 */
  const changed = new Set();
  for (const s of next) {
    const o = s.id && was[s.id];
    if (!o) { changed.add(s); continue; }
    if (dayOf(o, 'start') !== dayOf(s, 'start') || dayOf(o, 'end') !== dayOf(s, 'end')
      || (o.pid || '') !== (s.pid || '')) changed.add(s.id);
  }
  const isChanged = s => changed.has(s) || changed.has(s.id);

  /* 1. 起止不能倒 */
  for (const s of next) {
    const a = dayOf(s, 'start'), b = dayOf(s, 'end');
    if (a && b && b < a) return bad('dates', `「${s.name || '未命名'}」结束 ${fmt(b)} 早于开始 ${fmt(a)}`);
  }

  /* 2. 只允许两级：子任务的父必须还在 */
  const topIds = new Set(next.filter(s => !s.pid && s.id).map(s => s.id));
  for (const s of next) {
    if (s.pid && !topIds.has(s.pid)) return bad('depth', `「${s.name || '未命名'}」挂的上级阶段已经不在了`);
  }

  /* 3. 已经勾过完成的，日期不能再挪：已经发生的计划不该被悄悄改写 */
  for (const s of next) {
    const o = s.id && was[s.id];
    if (!o || !o.done) continue;
    if (dayOf(o, 'start') !== dayOf(s, 'start') || dayOf(o, 'end') !== dayOf(s, 'end'))
      return bad('done', `「${s.name || '未命名'}」已经勾了完成，日期不能再改`);
  }

  /* 4. 新增的节点不许和同层重名。两条同名子任务在进度里会算成两件独立的事，
        分母虚高一倍——「客户清单初稿」重复两次，进度就成了 4 个叶子各 25%。
        改存量时不查重名：库里已有的重名得让人改得动，不能一保存就被自己的数据卡死。 */
  if (ctx.checkDupAll) {
    const seen = new Set();
    for (const s of next) {
      const nm = (s.name || '').trim();
      if (!nm) continue;
      const k = (s.pid || '') + '\u0000' + nm;
      if (seen.has(k)) return bad('dup', `同一个${s.pid ? '阶段' : '任务'}下面有两个「${nm}」；改掉一个名字，或者只留一条`);
      seen.add(k);
    }
  } else if (ctx.newName) {
    const pid = ctx.newPid || '';
    const dup = next.some(s => s !== ctx.newNode && (s.pid || '') === pid
      && (s.name || '').trim() === ctx.newName.trim());
    if (dup) return bad('dup', `这个${pid ? '阶段' : '任务'}下面已经有「${ctx.newName}」了；是想改那一条，还是换个不同的名字？`);
  }

  /* 5. 同层区间不许相交。跟数组顺序无关——新增的一段可能落在中间，也可能比第一段还早；
        按「数组相邻两项」判会拿最后一段当邻居，跨年时必然误报。
        闭区间 [start, end]，缺 end 用 start；首尾相接（前一段到 11-06、后一段 11-07 起）合法。
        同一段自身不参与配对（按 id 各算一次）。
        依然只算涉及到「这次动过的节点」的配对：存量里的历史重叠不挡住无关编辑。 */
  const ivOf = s => {
    const a = dayOf(s, 'start') || dayOf(s, 'end');
    const b = dayOf(s, 'end') || dayOf(s, 'start');
    return (a && b) ? { a, b } : null;
  };
  const groups = new Map();
  for (const s of next) {
    const k = s.pid || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  for (const [pid, list] of groups) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        if (!isChanged(A) && !isChanged(B)) continue;
        const x = ivOf(A), y = ivOf(B);
        if (!x || !y) continue;
        if (x.a <= y.b && y.a <= x.b) {
          const [p, q] = x.a <= y.a ? [A, B] : [B, A];
          return bad('overlap', overlapMsg(next, p, q, pid));
        }
      }
    }
  }

  /* 6. 子任务必须落在父阶段的窗口里。阶段时间是设定的，不会被撑开：
        排不下就说明该改阶段（明确的动作），而不是让阶段背地里变长。
        同样只判这次动过的那一对，存量里出界的子任务不挡住无关的编辑。 */
  for (const s of next) {
    if (!s.pid) continue;
    const p = next.find(x => x.id === s.pid);
    if (!p) continue;
    if (!isChanged(s) && !isChanged(p)) continue;
    const ps = dayOf(p, 'start'), pe = dayOf(p, 'end') || ps;
    const ks = dayOf(s, 'start') || dayOf(s, 'end');
    const ke = dayOf(s, 'end') || ks;
    if (!ps || !pe) continue;
    if ((ks && ks < ps) || (ke && ke > pe)) return bad('window', windowMsg(next, s, p));
  }

  /* 7. 不超发布时定的总截止。这条以前只在服务端拦，人看到的是「保存失败」——
        改完了才告诉人不行，等于白干一次。
        只锁「别人发布给我」的活：自己建的专项，截止本来就是自己的计划结束日，
        服务端那边没主动改截止时也会自动跟着计划走（upsertTask 里的 !dueChanged 分支），
        前端要是也拦就成了「自己的活挪不动」。存量就超截止的，只在这次把结束日又往后推时才拦。 */
  const tops = next.filter(s => !s.pid);
  const ends = tops.map(s => dayOf(s, 'end')).filter(Boolean).sort();
  const taskEnd = ends.length ? ends[ends.length - 1] : '';
  const prevEnds = prev.filter(s => !s.pid).map(s => dayOf(s, 'end')).filter(Boolean).sort();
  const prevTaskEnd = prevEnds.length ? prevEnds[prevEnds.length - 1] : '';
  const due = (t && t.dueDate) || '';
  const dueLocked = !!(t && t.publisherNo && t.publisherNo !== t.ownerNo);
  if (due && dueLocked && taskEnd && taskEnd > due && taskEnd !== prevTaskEnd)
    return bad('due', `这样排到 ${fmt(taskEnd)}，超过发布时定的截止 ${fmt(due)}；要往后排，先让发布人改总截止`);

  /* 校验通过之后按时间重排同层：一级阶段按开始日升序，每个阶段后面紧跟自己的子任务。
     新增的一段不再「永远排在最后」——编号跟着时间走，列表上不会出现第 6 段的日期比第 3 段早。
     数组顺序就是渲染顺序（编号、data-idx 都按它算），所以这里就地重排，调用方拿到的就是最终顺序。 */
  const key = s => dayOf(s, 'start') || dayOf(s, 'end') || '9999-12-31';
  const byStart = (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const topsSorted = next.filter(s => !s.pid).sort(byStart);
  const kidsAll = next.filter(s => s.pid);
  const ordered = [];
  for (const p of topsSorted) {
    ordered.push(p);
    kidsAll.filter(k => k.pid === p.id).sort(byStart).forEach(k => ordered.push(k));
  }
  /* pid 指向已删阶段的孤儿留在末尾：第 2 条会先拦下它们，这里只是不把数组弄丢东西 */
  kidsAll.filter(k => !topsSorted.some(p => p.id === k.pid)).forEach(k => ordered.push(k));
  next.length = 0;
  ordered.forEach(s => next.push(s));

  return { ok: true, code: '', msg: '' };
}

/* 任务周期 = 一级阶段的包络（最早开始 → 最晚结束）。
   加段之后必须跟着更新：不然卡片、导出、服务端的截止校验还在用旧区间。 */
function restatTaskSpan(t) {
  const tops = (t.stages || []).filter(s => !s.pid);
  const ds = tops.map(s => dayOf(s, 'start')).filter(Boolean).sort();
  const de = tops.map(s => dayOf(s, 'end') || dayOf(s, 'start')).filter(Boolean).sort();
  if (ds.length) t.start = ds[0];
  if (de.length) t.end = de[de.length - 1];
}

/* 在父阶段的窗口里找第一个塞得下的空档。加子任务时默认用它，
   而不是把父阶段整段抄下来——抄整段等于保证「第二条一定和第一条重叠」。 */
function freeSlot(p, kids, len) {
  len = len || 1;
  const winS = p.start || p.date || TODAY;
  const winE = p.end || p.date || winS;
  const used = kids
    .map(k => ({ s: k.start || k.date, e: k.end || k.date || k.start }))
    .filter(x => x.s)
    .sort((a, b) => (a.s < b.s ? -1 : 1));
  let cur = winS;
  for (const u of used) {
    if (u.s > cur) {
      const room = diffDays(addDays(u.s, -1), cur) + 1;
      if (room >= len) return { start: cur, end: addDays(cur, len - 1), overflow: false };
    }
    if (u.e >= cur) cur = addDays(u.e, 1);
  }
  if (cur <= winE && diffDays(winE, cur) + 1 >= len)
    return { start: cur, end: addDays(cur, len - 1), overflow: false };
  /* 窗口满了：默认接在最晚那条后面，并让调用方把「阶段会被撑到哪天」写出来 */
  const lastE = used.length ? used[used.length - 1].e : winE;
  const ns = addDays(lastE, 1);
  return { start: ns, end: addDays(ns, len - 1), overflow: true };
}
const allLeavesDone = t => {
  const leaves = leavesOf(t.stages);
  return leaves.length ? leaves.every(s => s.done) : t.status === 'done';
};

const taskProg = t => {
  if (t.type === 'routine') return t.status === 'done' ? 100 : 0;
  const leaves = leavesOf(t.stages);
  if (leaves.length) return Math.round(leaves.filter(s => s.done).length / leaves.length * 100);
  return t.status === 'done' ? 100 : t.status === 'doing' ? 50 : 0;
};
const overdue = t => t.status !== 'done' && t.end < TODAY;

/* ============ 通用组件 ============ */
/* 发布人：这件事最开始是谁发起的（publisher_no 永不改），和「承接人」是两回事——
   接过去之后 owner 变了、计划归承接人排，但总截止还是发布人定的。
   自己发起的活不写，不然每一行都挂一句「我发布」，看着更乱。 */
function pubName(t) {
  const p = t && (t.publisherNo || t.ownerNo);
  return (!p || (S.me && p === S.me.no)) ? '' : nameOf(p);
}
/* 整张卡片头部用：一个标签，扫一眼就知道这活是谁派的 */
function pubTag(t) {
  const p = pubName(t);
  return p ? `<span class="tag pub" title="发布人：这条活由他发起，总截止也由他定；接收之后他只看进度">${esc(p)} 发布</span>` : '';
}
function typeChip(t) { return `<span class="chip ${t.type}">${TYPES[t.type].name}</span>`; }
function stTag(status) { return `<span class="tag ${ST[status].cls}">${ST[status].name}</span>`; }
function prioBadge(t) {
  const p = prioLabel(t);
  if (!p) return '';
  return `<span class="tag ${p === 'P0' ? 'red' : ''}">${p}</span>`;
}
/* 状态快捷改：勾选框只解决「做完了」，暂缓/进行中要进详情翻半天，
   所以列表里直接给一个状态下拉，一个动作到位。
   专项的阶段行也给：那一段属于哪条任务，改的就是那条任务的状态，省得再点进去。
   常规实例只有完成/未完成，用勾选框就够。 */
/* 状态快捷改：勾选框只解决「做完了」，暂缓/进行中要进详情翻半天，所以列表里直接给下拉。
   常规实例也能改——今天没空做，先挂「暂缓」是最常见的动作，不该逼人进详情。 */
function qStatusHTML(t, step) {
  return `<select class="qst s-${t.status}" data-act="qstatus" data-id="${t.id}" title="改整条任务的状态">` +
    ['todo', 'doing', 'paused', 'done'].map(k => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${ST[k].name}</option>`).join('') +
    `</select>`;
}
function taskRow(t, step, si) {
  const key = `${t.id}|${step ? si : ''}`;
  const done = step ? step.done : t.status === 'done';
  const delay = !step && t.auto && t.planDate && t.planDate !== t.start;
  const time = (step && step.time) || t.time;
  /* 节点行显示节点名（这是这一段的活），父任务名降级成标签做归属提示 */
  const stepName = step ? (step.name || '') : '';
  const title = stepName || t.title;
  const parentTag = stepName && stepName !== t.title ? `<span class="tag parent">${esc(t.title)}</span>` : '';
  const spanFrom = step ? (step.start || step.date || t.start) : t.start;
  const spanTo = step ? (step.end || step.date || t.end) : t.end;
  const late = step ? (!step.done && spanTo < TODAY) : overdue(t);
  const who = (t.assigneeNo && t.assigneeNo !== S.me.no) ? nameOf(t.assigneeNo) : '';
  const pub = pubName(t);
  /* 有状态下拉的普通任务不再重复写一遍状态；常规实例写「节点进度」 */
  const stText = step ? `${si + 1}/${t.stages.length} 节点` : (t.type === 'routine' ? ST[t.status].name : '');
  return `<div class="trow ${done ? 'done' : ''}${focusKey === key ? ' focus' : ''}" data-key="${key}">
    <span class="bar ${t.type}"></span>
    <div class="cb ${done ? 'on' : ''}" data-act="${step ? 'toggle-step' : 'toggle'}" data-id="${t.id}"${step ? ` data-idx="${si}"` : ''}>${done ? '✓' : ''}</div>
    <div class="body">
      <div class="t"><b>${esc(title)}</b>${typeChip(t)}${parentTag}
        ${stText}
        ${prioBadge(t)}
        ${delay ? '<span class="tag" title="按规则调整过日期">日期已调整</span>' : ''}
        ${late ? '<span class="tag red">已逾期</span>' : ''}</div>
      <div class="meta">
        <span>${time ? time + ' · ' : ''}${spanFrom === spanTo ? fmt(spanFrom) : fmt(spanFrom) + ' → ' + fmt(spanTo)}</span>
        ${pub ? `<span class="pubm" title="发布人：这条活由他发起，总截止由他定">${esc(pub)} 发布</span>` : ''}
        ${who ? `<span>承接：${esc(who)}</span>` : ''}
        <span>${catName(t.cat1, t.cat2)}</span>
      </div>
    </div>
    <div class="right">${qStatusHTML(t, step)}<button class="btn sm ghost" data-act="open" data-id="${t.id}">详情</button></div>
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
        <div class="card-h"><h2>等你处理</h2><div class="spacer"></div>
          <span class="pill warn">${pending.length + (S.stageIntake || []).length} 项</span></div>
        ${pending.length || (S.stageIntake || []).length || (S.noticeGroups || []).length ? `
          ${pending.length ? `<div class="kv"><span>等你立项的整件事</span><b>${pending.length} 项</b></div>` : ''}
          ${(S.stageIntake || []).length ? `<div class="kv"><span>分给你的子任务</span><b>${S.stageIntake.length} 条任务</b></div>` : ''}
          ${(S.noticeGroups || []).length ? `<div class="kv"><span>有变动</span><b>${S.noticeGroups.length} 条任务</b></div>` : ''}`
        : '<div class="empty">暂无待处理事项</div>'}
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
          <button class="btn" data-act="new" data-type="assign">发布新任务给组员</button>
          <button class="btn" data-act="new" data-type="special">新建专项（含阶段计划）</button>
          <button class="btn" data-act="new-rule">新建常规工作规则</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============ 视图：发布任务 ============ */
/* 这一页回答四个问题：
   ① 我派出去的活干到哪了  ② 下属的常规工作推得怎么样
   ③ 下属的专项项目推得怎么样  ④ 我在关注的事现在怎么样
   四块各管各的，别把「我关注」和「我发布」混在一起——同一件事出现在两块里，人会以为出 bug 了。 */
function viewAssign() {
  /* 「我发布的」= 派出去的东西，无论对方接没接。
     自派的（选承接人=自己）不在这里——它落成一条专项，归「专项工作」，
     同一件事只出现在一个地方，否则用户会以为系统重了。 */
  const list = S.tasks.filter(t => {
    const pub = t.publisherNo || t.ownerNo;
    if (pub !== S.me.no) return false;
    if (t.type === 'assign') return true;        /* 还没被接收 */
    return t.ownerNo !== S.me.no;                /* 已经移交出去 */
  }).sort((a, b) => (a.end < b.end ? -1 : 1));
  const doing = list.filter(t => t.status === 'doing').length;
  const late = list.filter(overdue).length;
  const spMembers = buildSpecialMembers();
  const spCount = spMembers.reduce((a, m) => a + m.specials.length, 0);
  const following = buildFollowing();
  return `
  <div class="grid-4">
    ${statCard('', '我发布的', list.length)}
    ${statCard('doing', '进行中', doing)}
    ${statCard('done', '已完成', list.filter(t => t.status === 'done').length)}
    ${statCard('paused', '逾期未完成', late)}
  </div>
  <div class="card" style="margin-top:14px">
    <div class="card-h"><h2>我发布的任务</h2><span class="hint">派出去之后归承接人管，你在这里看进度；给自己建的活不在这里，在「专项工作」里</span>
      <div class="spacer"></div>
      <button class="btn primary sm" data-act="new" data-type="assign">+ 发布任务</button></div>
    ${list.length ? `<table>
      <thead><tr><th style="width:28%">任务</th><th>承接人</th><th>截止</th><th>阶段进度</th><th>达成标准</th><th>状态</th><th></th></tr></thead>
      <tbody>
      ${list.map(t => {
        const p = taskProg(t);
        /* 0.5/0.6 时代的派生副本还留在库里：照旧挂在下面，标清楚是旧版，
           新流程不再产生这种东西。 */
        const carried = S.tasks.filter(x => x.sourceId === t.id);
        const cross = t.assigneeNo !== S.me.no && !S.subs.some(m => m.no === t.assigneeNo);
        const pending = t.type === 'assign' && t.intakeStatus === 'pending';
        return `<tr>
          <td style="max-width:250px"><b>${esc(t.title)}</b><div class="mini">${catName(t.cat1, t.cat2)} ${prioLabel(t) ? '· ' + prioLabel(t) : ''}</div>
            ${carried.map(x => `<div class="mini carry" data-act="open" data-id="${x.id}"
                title="旧版承接生成的副本"><span class="carry-ar">↳</span>旧版承接 · ${esc(nameOf(x.ownerNo))} 拆出「${esc(x.title)}」
                <b>${taskProg(x)}%</b> · ${ST[x.status] ? ST[x.status].name : ''}${overdue(x) ? ' · <span style="color:#dc2626">已逾期</span>' : ''}</div>`).join('')}</td>
          <td style="white-space:nowrap">${esc(nameOf(t.assigneeNo))}${cross ? ' <span class="tag">跨级</span>' : ''}${pending ? ' <span class="tag">待接收</span>'
            : ` <span class="tag done">已移交</span>`}</td>
          <td class="mini" style="white-space:nowrap">${fmt(t.dueDate || t.end)}${overdue(t) ? ' <span class="tag red">逾期</span>' : ''}</td>
          <td><div style="display:flex;align-items:center;gap:8px;white-space:nowrap"><div class="prog" style="width:56px"><i class="${p === 100 ? 'g' : ''}" style="width:${p}%"></i></div><span class="mini">${p}%${t.stages && t.stages.length ? ` · ${leavesOf(t.stages).filter(s => s.done).length}/${leavesOf(t.stages).length} 段` : ''}</span></div></td>
          <td class="mini" style="max-width:200px;min-width:140px">${esc(cut(t.std || '未填写', 26))}</td>
          <td>${stTag(t.status)}</td>
          <td><button class="btn sm ghost" data-act="open" data-id="${t.id}">查看</button></td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>` : '<div class="empty">还没有发布过任务</div>'}
  </div>

  <div class="card">
    <div class="card-h"><h2>下属常规工作推进情况</h2>
      <span class="hint">默认折叠为一行汇总，点成员展开；「关注」某一条后，能看到它的完整节点</span>
      <div class="spacer"></div><span class="mini">已关注 ${(S.watch || []).filter(w => (w.kind || 'routine') === 'routine').length} 条</span></div>
    <div>${S.members.length ? S.members.map(memberBlock).join('') : '<div class="empty">暂无直接下属</div>'}</div>
    <div class="note" style="margin-top:2px">关注只是你本人的视图偏好：不通知下属、不改他们的任何数据。规则与节点的编辑权始终在本人手里，你只能看状态。</div>
  </div>

  <div class="card">
    <div class="card-h fold" data-act="fold-special">
      <h2>下属专项工作推进情况</h2>
      <span class="hint">${spCount ? `${spCount} 条专项` : '暂无专项'}${openSpecialBlock ? '' : ' · 默认收起，点这里展开'}</span>
      <div class="spacer"></div><span class="mini">${openSpecialBlock ? '收起 ▴' : '展开 ▾'}</span></div>
    ${openSpecialBlock
      ? (spMembers.filter(m => m.specials.length).length
        ? spMembers.filter(m => m.specials.length).map(specialMemberBlock).join('')
        : '<div class="empty">下属还没有立项专项任务。专项是「需要持续推进的大项目」，阶段拆得越清楚，进度越看得准。</div>')
      : ''}
  </div>

  <div class="card">
    <div class="card-h"><h2>我关注的任务</h2>
      <span class="hint">你点的「关注」，以及别人让你知情的专项，都汇总在这里</span>
      <div class="spacer"></div><span class="mini">${following.length} 条</span></div>
    ${following.length ? following.map(followRowHTML).join('')
      : '<div class="empty">还没有关注的事。在上面两块里点「☆ 关注」，或者让别人把你设成知情人，这里就会列出来。</div>'}
    <div class="note" style="margin-top:2px">自己发布的任务不在这里，仍在上面的「我发布的任务」里；同一件事只出现在一个地方。</div>
  </div>`;
}

/* ============ 下属专项工作推进情况 ============ */
/* 和常规工作一个路子：按人列出来，每条专项可以「关注」，
   关注后出现在「我关注的任务」里。专项看的是阶段（一个大项目分几段），不是节点。 */
function buildSpecialMembers() {
  return S.subs.map(sub => ({
    no: sub.no, name: sub.name, role: sub.role, dept: sub.dept,
    specials: S.tasks.filter(t => t.type === 'special' && t.ownerNo === sub.no)
      .sort((a, b) => (a.end < b.end ? -1 : 1))
  }));
}
function isWatchedTask(subNo, taskId) {
  return (S.watch || []).some(w => (w.kind || 'routine') === 'special' && w.subNo === subNo && w.taskId === taskId);
}
function specialMemberBlock(m) {
  return `<div class="memrow open" style="cursor:default">
    <div class="ava3">${esc(m.name.slice(-1))}</div>
    <div class="mwho"><b>${esc(m.name)}</b> <span class="mini">${esc(m.role)}</span></div>
    <span class="rmeta">${m.specials.length} 条专项</span>
    <span class="mini">${esc(m.dept || '')}</span>
    <span class="mini">展开中</span>
  </div>
  <div class="mem-slot">${m.specials.map(t => specialLineHTML(m, t)).join('')}</div>`;
}
function specialLineHTML(m, t) {
  const w = isWatchedTask(m.no, t.id);
  const leaves = leavesOf(t.stages || []);
  const cur = leaves.find(s => !s.done) || null;
  const late = overdue(t);
  const p = taskProg(t);
  /* 这一行是「某个下属名下的专项」，所以判据是「跟他本人对不对得上」：
     不是他自己起的，就标出真正的发布人（可能是我，也可能是别人）。 */
  const pub0 = t.publisherNo || t.ownerNo;
  const fromOther = pub0 && pub0 !== m.no;
  return `<div class="rline ${w ? 'open' : ''}">
    <span class="rnm">${esc(t.title)}</span>
    ${fromOther ? `<span class="tag pub" title="发布人：这条活不是他自己起的">${esc(nameOf(pub0))} 发布</span>` : ''}
    <span class="rmeta">${fmt(t.start)} → ${fmt(t.end)}</span>
    <span class="rmeta">${leaves.length ? `${leaves.filter(s => s.done).length}/${leaves.length} 项` : '未拆阶段'}</span>
    <span class="curnode ${late ? 'warn' : ''}">${cur
      ? (late ? '卡在：' : '当前：') + esc(cur.name || '阶段') + ' · ' + fmt(cur.start || cur.date)
      : (t.status === 'done' ? '已全部完成' : '还没开始')}</span>
    <span class="mini">${p}%</span>
    ${stTag(t.status)}
    <span class="tag-watch ${w ? '' : 'off'}" data-act="watch-task" data-m="${m.no}" data-t="${t.id}"
      title="${w ? '取消关注' : '关注后出现在「我关注的任务」里'}">${w ? '★ 已关注' : '☆ 关注'}</span>
    <button class="btn sm ghost" data-act="open" data-id="${t.id}">查看</button>
  </div>`;
}

/* ============ 我关注的任务 ============ */
/* 三个来源：
   ① 我主动关注的下属常规     —— watch.kind = 'routine'
   ② 我主动关注的下属专项     —— watch.kind = 'special'
   ③ 别人让我知情的专项       —— task_observer 里有我（越级关注的入口）
   自己发布的任务不在这里，它在「我发布的任务」里。
   ② 和 ③ 会撞车：同一名下属的专项，我既关注了、他又把我设成知情人。
   那时只出一行（按「主动关注」算）——不然「我关注的任务」里同一件事出现两次，
   而这块的标题就是「同一件事只出现在一个地方」。 */
function buildFollowing() {
  const out = [];
  (S.watch || []).filter(w => (w.kind || 'routine') === 'routine' && w.ruleId).forEach(w => {
    const m = S.members.find(x => x.no === w.subNo);
    const r = m && (m.routines || []).find(x => x.id === w.ruleId);
    if (r) out.push({ kind: 'routine', who: m.name, m, r });
  });
  const seenT = new Set();
  (S.watch || []).filter(w => w.kind === 'special' && w.taskId).forEach(w => {
    const t = S.tasks.find(x => x.id === w.taskId);
    if (t && !seenT.has(t.id)) { seenT.add(t.id); out.push({ kind: 'special', who: nameOf(t.ownerNo), t }); }
  });
  S.tasks.filter(t => t.observer && t.type === 'special').forEach(t => {
    if (seenT.has(t.id)) return;
    seenT.add(t.id);
    out.push({ kind: 'informed', who: nameOf(t.ownerNo), t });
  });
  return out;
}
function followRowHTML(f) {
  if (f.kind === 'routine') {
    const r = f.r;
    const cur = curNodeOf(r);
    const late = cur && cur.date < TODAY;
    return `<div class="follow-row">
      <span class="tag">常规</span>
      <span class="who">${esc(f.who)}</span>
      <span class="rnm">${esc(r.title)}</span>
      <span class="rmeta">${cycleCN(r.cycle)} · 本周 ${r.weekDone}/${r.weekTotal}</span>
      <span class="curnode ${late ? 'warn' : ''}">${cur
        ? (late ? '卡在：' : '当前：') + esc(cur.name || '节点') + ' · ' + fmt(cur.date)
        : '本轮全部完成'}</span>
    </div>`;
  }
  const t = f.t;
  const leaves = leavesOf(t.stages || []);
  const p = taskProg(t);
  return `<div class="follow-row" data-act="open" data-id="${t.id}" style="cursor:pointer">
    <span class="tag">${f.kind === 'informed' ? '知情' : '专项'}</span>
    <span class="who">${esc(f.who)}</span>
    <span class="rnm">${esc(t.title)}</span>
    <span class="rmeta">${leaves.length ? `${leaves.filter(s => s.done).length}/${leaves.length} 项` : '未拆阶段'}</span>
    <div class="prog" style="width:56px"><i class="${p === 100 ? 'g' : ''}" style="width:${p}%"></i></div>
    <span class="mini">${p}%</span>
    ${stTag(t.status)}
    ${f.kind === 'informed' ? `<span class="mini">${esc(f.who)} 让你知情</span>` : ''}
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
            <h2>${esc(t.title)}</h2>${stTag(t.status)}${pubTag(t)}${prioBadge(t)}
            ${t.status !== 'done' && left < 0 ? '<span class="tag red">逾期 ' + Math.abs(left) + ' 天</span>' : t.status !== 'done' && left <= 3 ? '<span class="tag warn">剩 ' + left + ' 天</span>' : ''}
            <div class="spacer"></div><button class="btn sm ghost" data-act="open" data-id="${t.id}">查看</button>
          </div>
          <div class="mini" style="margin-bottom:8px">${fmt(t.start)} → ${fmt(t.end)} · ${catName(t.cat1, t.cat2)}${stageMeta(t)}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <div class="prog" style="flex:1"><i class="${p === 100 ? 'g' : ''}" style="width:${p}%"></i></div>
            <span class="mini">${p}%</span>
          </div>
          ${t.stages && t.stages.length ? stageRows(t.stages).map(r => `<div class="stage ${r.sub ? 'sub' : ''} ${r.s.done ? 'on' : ''}">
            <div class="n">${r.s.done ? '✓' : r.no}</div>
            <div class="t ${r.s.done ? 'done' : ''}"><span class="sn" style="text-decoration:${r.s.done ? 'line-through' : 'none'}">${esc(r.s.name)}</span><small>${r.s.start || r.s.end ? dateSpan(r.s) : ''}</small></div>
            ${r.sub && r.s.who ? `<span class="mini who-ro">${esc(nameOf(r.s.who))}</span>` : ''}
          </div>`).join('') : '<div class="mini">还没有阶段，进入详情可拆分阶段计划</div>'}
        </div>`;
      }).join('')}
    </div>` : '<div class="empty">还没有专项工作</div>'}
  </div>`;
}

/* ============ 视图：任务承接台 ============ */
function viewIntake() {
  const pending = S.intake;
  const subIn = S.stageIntake || [];
  const groups = S.noticeGroups || [];
  const accepted = acceptedList();
  return `
  <div class="grid-2">
    <div>
      <div class="card">
        <div class="card-h"><h2>等你立项的任务</h2><span class="hint">接收 = 这条活归你管；接过来之后先理计划，理完再派发</span>
          <div class="spacer"></div><span class="pill warn">${pending.length} 项</span></div>
        ${pending.length ? pending.map(i => `<div class="rule-card">
          <div class="card-h" style="margin-bottom:6px"><h2>${esc(i.title)}</h2>
            <span class="tag">${esc(i.from)} 发布</span><div class="spacer"></div><span class="tag red">${fmt(i.due)} 前</span></div>
          <div class="mini" style="margin-bottom:4px">达成标准：${esc(i.std || '未填写')}</div>
          <div class="split"><button class="btn primary sm" data-act="intake-accept" data-id="${i.id}">接收</button></div>
          <div class="mini" style="margin-top:6px;line-height:1.5">接收后它会进「专项工作」，你可以改阶段、派人、排期，但总截止是发布人定的。</div>
        </div>`).join('') : '<div class="empty">没有等你立项的任务</div>'}
      </div>

      <div class="card">
        <div class="card-h"><h2>分给你的子任务</h2><span class="hint">承接人已经派发，你接了就进自己的待办</span>
          <div class="spacer"></div><span class="pill warn">${subIn.length} 条任务</span></div>
        ${subIn.length ? subIn.map(g => `<div class="rule-card">
          <div class="card-h" style="margin-bottom:6px"><h2>${esc(g.task.title)}</h2>
            <span class="tag">${esc(g.from)} 分给你 ${g.stages.length} 段</span>
            ${(g.task.publisherNo || g.task.ownerNo) && (g.task.publisherNo || g.task.ownerNo) !== g.task.ownerNo
              ? `<span class="tag pub" title="这整件事的发布人，承接人是 ${esc(nameOf(g.task.ownerNo))}">${esc(nameOf(g.task.publisherNo || g.task.ownerNo))} 发布</span>` : ''}
            <div class="spacer"></div><span class="tag red">最早 ${fmt(g.earliest)}</span></div>
          ${g.stages.map(s => `<div class="kv"><span>${esc(s.name || '子任务')} · ${fmt(s.start || s.date)} → ${fmt(s.end || s.date)}</span>
            <b><button class="btn sm ghost" data-act="stage-join" data-id="${g.id}" data-sid="${esc(s.id)}">加入待办</button></b></div>`).join('')}
          <div class="mini" style="margin-top:6px;line-height:1.5">加入后变成一条待办：计划和日期由承接人维护，你这边只勾完成；要调期找承接人。</div>
        </div>`).join('') : '<div class="empty">没有分给你的子任务</div>'}
      </div>

      <div class="card">
        <div class="card-h"><h2>有变动的任务</h2><span class="hint">派发之后改期、换人、删除、完成，都会记在这里</span>
          <div class="spacer"></div><span class="pill warn">${groups.length} 条</span></div>
        ${groups.length ? groups.map(g => `<div class="rule-card">
          <div class="card-h" style="margin-bottom:6px"><h2>${esc(g.title)}</h2>
            <div class="spacer"></div><button class="btn sm ghost" data-act="notice-seen" data-tid="${g.taskId}">知道了</button></div>
          ${g.items.map(n => `<div class="mini" style="padding:3px 0"><span class="tag ${n.kind === 'removed' ? 'red' : n.kind === 'moved' ? 'warn' : n.kind === 'stage_done' ? 'done' : ''}">${
            n.kind === 'removed' ? '已移除' : n.kind === 'moved' ? '改期' : n.kind === 'reassigned' ? '换人' : n.kind === 'stage_done' ? '完成' : '新派'}</span> ${esc(n.summary || '')}</div>`).join('')}
        </div>`).join('') : '<div class="empty">没有变动</div>'}
      </div>
    </div>

    <div>
      <div class="card">
        <div class="card-h"><h2>我接的任务</h2><span class="hint">${accepted.length} 项</span></div>
        ${accepted.length ? accepted.map(t => {
          const pub = t.publisherNo || t.ownerNo;
          return `<div style="padding:8px 0;border-bottom:1px dashed var(--line2)">
          <div class="split"><b style="font-size:12.5px">${esc(t.title)}</b><span class="tag done">${TYPES[t.type] ? TYPES[t.type].name : ''}</span></div>
          <div class="mini" style="margin-top:4px">${pub === S.me.no ? '我自己建的' : `${esc(nameOf(pub))} 发布`} · 截止 ${fmt(t.dueDate || t.end)}<br/>${fmt(t.start)} → ${fmt(t.end)}</div>
        </div>`;
        }).join('') : '<div class="empty">还没有接过来的活</div>'}
      </div>
      <div class="card">
        <div class="card-h"><h2>这一页在管什么</h2></div>
        <div class="note">
          接收和派发是两件事，别混：<br/>
          · <b>接收</b> = 这条活归你管，进你的专项工作；<br/>
          · <b>派发</b> = 你理完计划后，把其中的子任务分出去，对方才收得到；<br/>
          · 对方点「加入待办」，那一段才会变成他今天的活；<br/>
          · 派发之后再改期、换人、删除，他这里都会出现一条提醒。
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
  /* 月视图固定从「上月 26 日」开始，到当月最后一天结束；26 日之前补空格保持星期对齐。
     这是账期口径，不随当月 1 日是星期几而变化。 */
  const cycleStart = prevMonth26(calCursor), gridStart = weekStart(cycleStart);
  const last = monthEnd(calCursor);
  const slots = Math.ceil((diffDays(last, gridStart) + 1) / 7) * 7;
  return Array.from({ length: slots }, (_, i) => {
    const d = addDays(gridStart, i);
    return { d, blank: d < cycleStart || d > last, in: d >= cycleStart && d <= last };
  });
}
function prevMonth26(s) {
  const d = parse(monthStart(s));
  return iso(new Date(d.getFullYear(), d.getMonth() - 1, 26));
}
/* 日历卡片：来源靠最初的底色和字色区分，状态靠左侧色条 + 右侧短文字。
   待开展是默认状态，不额外占文字宽度；进行中 / 暂缓 / 已完成都直接写明白。
   逾期只看计划结束日是否已过，用红框和「逾期」提示，不覆盖来源底色；
   已完成的活再晚也是记录，不该在日历上常亮红灯。 */
function chipLate(t, step) {
  if (step) return !step.done && !!((step.end || step.date)) && (step.end || step.date) < TODAY;
  if (t.status === 'done') return false;
  return (t.end || t.start) < TODAY;
}
const CHIP_STATE = { doing: '进行中', paused: '暂缓', done: '已完成' };
function calChipHTML(t, step, si, label, maxLen) {
  const stKey = (step && step.done) ? 'done' : (ST[t.status] ? t.status : 'todo');
  const late = chipLate(t, step);
  const tip = (step && step.name ? t.title + ' · ' + step.name : t.title) + ' · ' + ST[stKey].name + (late ? ' · 已逾期' : '')
    + (pubName(t) ? ' · ' + pubName(t) + ' 发布' : '')
    + '　（点一下：在右侧当天清单里定位，可直接改状态）';
  const adjusted = step ? false : (t.auto && t.planDate && t.planDate !== t.start);
  const stateText = late ? '逾期' : (CHIP_STATE[stKey] || '');
  /* 带阶段的任务，正文写的是阶段名，角标里补一句它属于哪件事。
     没有阶段的任务正文就是任务名，不用再重复一遍。 */
  const par = (step && step.name) ? t.title : '';
  return `<span class="chip cal ${t.type} s-${stKey}${late ? ' overdue' : ''}${adjusted ? ' adjusted' : ''}"
    draggable="true" data-drag='${JSON.stringify({ id: t.id, s: si })}' data-act="cal-focus"
    data-id="${t.id}" data-si="${si == null ? -1 : si}" data-st="${stKey}"${late ? ' data-late="1"' : ''}
    title="${esc(tip)}"><span class="lbl">${esc(maxLen ? cut(label, maxLen) : label)}</span>${stateText ? `<i class="st">${stateText}</i>` : ''}${par ? `<span class="par">${esc(cut(par, 16))}</span>` : ''}</span>`;
}
/* 一格最多铺这么多条，再多就折成「还有 N 条」——点一下这格，右边当日清单是全的。
   以前是硬截 4 条且剩余的只写个 +N，常规任务没有优先级、排序天然靠后，
   第一个被截掉的就是它，于是「同一天有好几件活时，常规那条在日历上不见了」。 */
const CELL_MAX = 8;
function cellHTML(c) {
  if (c.blank) return '<div class="cell blank"></div>';
  const d = c.d, items = sortOcc(occOn(d, 'ends'));
  const cls = ['cell'];
  if (!c.in) cls.push('out');
  if (d === TODAY) cls.push('today');
  if (isHoliday(d)) cls.push('holiday');
  else if (!isWorkday(d)) cls.push('weekend');
  const shown = items.slice(0, CELL_MAX);
  const chips = shown.map(o => {
    const label = o.step && o.step.name ? o.step.name : o.t.title;
    return calChipHTML(o.t, o.step, o.si, label);
  }).join('');
  const rest = items.length - shown.length;
  return `<div class="${cls.join(' ')}" data-date="${d}" data-total="${items.length}">
    <div class="dhead">
      <span class="num ${dow(d) === 0 ? 'sun' : ''}">${parse(d).getDate()}</span>
      ${d === TODAY ? '<span class="todayb">今天</span>' : ''}
      ${isHoliday(d) ? `<span class="hol">休·${HOL[d]}</span>` : isMakeup(d) ? '<span class="mk">补班</span>' : ''}
    </div>
    ${chips}
    ${rest > 0 ? `<button class="more">还有 ${rest} 条，点开这天看</button>` : ''}
  </div>`;
}
/* 点日历上的一条活 → 在右侧当天清单里把它滚到眼前并高亮。
   不在这里弹详情：人点日历上的卡，十有八九是想改状态或看看今天还剩什么，
   就地改最省事；真想看全貌，那一行右边本来就有「详情」。 */
function scrollToFocus() {
  if (!focusKey) return;
  const row = document.querySelector(`#view .tlist .trow[data-key="${focusKey}"]`);
  if (!row) { focusKey = ''; return; }
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const mine = focusKey;
  setTimeout(() => {
    row.classList.remove('focus');
    if (focusKey === mine) focusKey = '';
  }, 2200);
}
function viewCalendar() {
  const cells = calCells();
  const head = calMode === 'month'
    ? `${parse(calCursor).getFullYear()} 年 ${parse(calCursor).getMonth() + 1} 月`
    : `本周 · ${fmt(cells[0].d)} - ${fmt(cells[6].d)}`;
  const dayItems = sortOcc(occOn(selDay, 'all'));
  return `
  <div class="grid-cal">
    <div class="card">
      <div class="cal-head">
        <span class="m">${head}</span>
        ${calMode === 'month' ? `<span class="mini">${fmt(prevMonth26(calCursor))} 起</span>` : ''}
        <div class="seg">
          <button data-act="cal-mode" data-mode="month" class="${calMode === 'month' ? 'on' : ''}">月</button>
          <button data-act="cal-mode" data-mode="week" class="${calMode === 'week' ? 'on' : ''}">周</button>
        </div>
        <button class="btn sm" data-act="cal-nav" data-step="-1">‹</button>
        <button class="btn sm" data-act="cal-nav" data-step="1">›</button>
        <button class="btn sm ghost" data-act="cal-today">回到今天</button>
        <div class="spacer"></div>
        <span class="mini" id="dragHint">拖动 = 改期 · 单击 = 在右侧清单里定位</span>
      </div>
      <div class="cal">
        ${['一', '二', '三', '四', '五', '六', '日'].map(x => `<div class="dow">周${x}</div>`).join('')}
        ${cells.map(cellHTML).join('')}
      </div>
      <div class="cal-legend">
        <span class="lg-cap">来源</span>
        <span><i class="lgsrc assign"></i>发布</span>
        <span><i class="lgsrc routine"></i>常规</span>
        <span><i class="lgsrc special"></i>专项</span>
        <span><i class="lgsrc temp"></i>临时</span>
        <span class="lg-sep"></span>
        <span class="lg-cap">状态</span>
        <span><i class="lgst todo"></i>待开展</span>
        <span><i class="lgst doing"></i>进行中</span>
        <span><i class="lgst paused"></i>暂缓</span>
        <span><i class="lgst done"></i>已完成</span>
        <span><i class="lglate"></i>已逾期</span>
        <span class="lg-sep"></span>
        <span><span class="hol" style="font-size:10px;background:#fde8e8;color:#c0392b;border-radius:4px;padding:0 4px">休</span> 法定节假日</span>
        <span><span class="mk" style="font-size:10px;background:#e8f7f4;color:#0b7a6d;border-radius:4px;padding:0 4px">补班</span> 调休上班</span>
        <span>右下角小三角 = 常规实例本次改期</span>
      </div>
    </div>
    <div>
      <div class="card">
        <div class="card-h"><h2>${fmtFull(selDay)}</h2>
          <div class="spacer"></div>
          ${isHoliday(selDay) ? '<span class="pill warn">法定假日</span>' : isMakeup(selDay) ? '<span class="pill green">补班</span>' : isWorkday(selDay) ? '<span class="pill">工作日</span>' : '<span class="pill">周末</span>'}
        </div>
        <div class="tlist">
          ${dayItems.length ? dayItems.map(o => taskRow(o.t, o.step, o.si)).join('')
            : `<div class="empty">${isWorkday(selDay) ? '这一天还没有安排' : '这天是休息日，不排活；跨周末的专项阶段只在工作日显示'}</div>`}
        </div>
        <button class="btn sm" style="margin-top:10px;width:100%" data-act="new-day">+ 在这一天加临时任务</button>
      </div>
      <div class="card">
        <div class="card-h"><h2>今日待办（可拖到日历）</h2></div>
        <div class="stack">
          ${todayTasks().map(o => calChipHTML(o.t, o.step, o.si,
            o.step && o.step.name ? o.t.title + ' · ' + o.step.name : o.t.title, 18)).join('') || '<span class="mini">今天没有待办</span>'}
        </div>
        <div class="note" style="margin-top:12px">
          拖到某一天 = 改这一段的计划日期，不是把活交给别人：<br/>
          · 没拆阶段的活：整段一起平移，工期天数不变<br/>
          · 专项 / 发布任务：拖的是当前这一个阶段，保持阶段长短，且不能压到前后阶段上<br/>
          · 常规工作：只改这一次，规则本身不动，仍只能落在工作日
        </div>
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
  /* 分类不再统一维护，这里只回看「实际用过哪些」，当个标签统计用 */
  const catUse = {};
  S.tasks.forEach(t => {
    const n = catName(t.cat1, t.cat2);
    if (n && n !== '未分类') catUse[n] = (catUse[n] || 0) + 1;
  });
  const catTop = Object.keys(catUse).sort((a, b) => catUse[b] - catUse[a]).slice(0, 10);
  return `
  <div class="card" style="margin-bottom:14px">
    <div class="card-h"><h2>账号与汇报关系</h2><span class="hint">工号 + 密码登录；一个直属上级</span>
      <div class="spacer"></div><button class="btn sm" data-act="switch-user">修改上级</button></div>
    <div class="authkv">
      <div><span>登录账号</span><b>${S.me ? esc(S.me.name) + ' · ' + esc(S.me.no) : '未登录'}</b></div>
      <div><span>部门 / 岗位</span><b>${S.me ? esc(S.me.dept) + ' · ' + esc(S.me.role) : '—'}</b></div>
      <div><span>直属上级</span><b>${S.me && S.me.mgr ? esc(S.me.mgr.name) + ' · ' + esc(S.me.mgr.no) : '<span style="color:#b45309">未设置</span>'}</b></div>
      <div><span>我的下属</span><b>直接下属 ${S.subs.length} 人（向下 1 层）</b></div>
      <div><span>发布对象</span><b>全公司 ${(S.roster || []).length - 1} 位同事（不限于下属）</b></div>
      <div><span>能否派活</span><b>${S.me && empActivated(S.me.no) ? '已开通，可以派活' : '<span style="color:#b45309">你还没登录过工作台，先自己登录一次</span>'}</b></div>
    </div>
    <div class="note" style="margin-top:10px">上级不是必填项：不设上级照样能发布任务、承接任务。只是不设上级的人不会出现在别人的「下属」名单里，上级也就看不到你的常规工作与专项进展。</div>
    <div class="note" style="margin-top:6px">一个账号只有一个直属上级；防环校验会拒绝选择自己或自己的下级。改上级后，已发布的任务仍保留原上级可见，新增任务只对新上级可见。</div>
  </div>
  <div class="card" id="pwdCard" style="margin-bottom:14px">
    <div class="card-h"><h2>修改密码</h2><span class="hint">初始密码 = 工号，改完请自己记住</span></div>
    <div class="split" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div class="auth-field" style="margin:0"><label>原密码</label><input id="pwd_old" type="password" autocomplete="current-password"/></div>
      <div class="auth-field" style="margin:0"><label>新密码（至少 6 位）</label><input id="pwd_new" type="password" autocomplete="new-password"/></div>
      <button class="btn sm primary" data-act="change-pwd">修改密码</button>
    </div>
    <div class="note" style="margin-top:10px">改完密码，其它设备上的登录会立即失效。忘了密码只能找管理员重置为工号。</div>
  </div>
  <div class="grid-2">
    <div class="card">
      <div class="card-h"><h2>任务分类</h2><span class="hint">新建任务时手填，不做统一维护</span></div>
      <div class="note">分类只用来给任务贴个标签，方便在列表里一眼认出这类活。新建或编辑任务时直接写；写过的会自动出现在输入提示里，写错也不影响任务本身。</div>
      <div class="split" style="margin-top:12px;flex-wrap:wrap;gap:6px">
        ${catTop.map(n => `<span class="tag">${esc(n)} · ${catUse[n]}</span>`).join('') || '<span class="mini">还没有用过分类</span>'}
      </div>
      <div class="note" style="margin-top:10px">临时任务默认填「其他 / 临时事项」，可改。分类不做删除、改名这类集中管理，避免为几个字去维护一棵树。</div>
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
        <div class="kv"><span>登录</span><b>工号 + 密码（初始密码=工号，可自助修改）</b></div>
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
/* 管理账号（admin）不参与业务：没有任务、没有花名册、没有下属，只有一个管理面板。
   侧边栏也不给它业务入口——点进去只会看到一屏空列表，像坏了一样。 */
function viewAdmin() {
  return `
  <div class="card" style="margin-bottom:14px">
    <div class="card-h"><h2>仍用初始密码的员工</h2><span class="hint">含从没登录过的人（密码就是工号）</span>
      <div class="spacer"></div><button class="btn sm" data-act="admin-pw">刷新</button></div>
    <div id="adminPwdList"><div class="note">读取中…</div></div>
  </div>
  <div class="card" style="margin-bottom:14px">
    <div class="card-h"><h2>会话与设备</h2><span class="hint">最近 200 条登录会话</span>
      <div class="spacer"></div><button class="btn sm" data-act="admin-sess">刷新</button></div>
    <div id="adminSessList"><div class="note">读取中…</div></div>
  </div>
  <div class="card">
    <div class="card-h"><h2>管理密码</h2><span class="hint">至少 8 位；改完其它设备上的登录会失效</span></div>
    <div class="split" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
      <div class="auth-field" style="margin:0"><label>原密码</label><input id="pwd_old" type="password" autocomplete="current-password"/></div>
      <div class="auth-field" style="margin:0"><label>新密码（至少 8 位）</label><input id="pwd_new" type="password" autocomplete="new-password"/></div>
      <button class="btn sm" data-act="change-pwd">修改密码</button>
    </div>
    <div class="note" style="margin-top:10px">这个账号不占工号、不在花名册里，也不能被设成任何人的上级；
      它只能重置员工密码、看初始密码名单和会话设备，看不到任何任务内容。</div>
  </div>`;
}
function renderAdmin() {
  document.body.classList.add('admin-mode');
  $('#meAva').textContent = '管';
  $('#meName').textContent = '系统管理员';
  $('#meMeta').textContent = '管理账号 · admin';
  $('#meMgr').textContent = '';
  renderAcct('管', '系统管理员', '管理账号 · admin');
  const pill = $('#workdayPill');
  pill.style.display = 'none';
  const badge = $('#intakeBadge');
  if (badge) badge.style.display = 'none';
  $$('.nav-item').forEach(el => el.classList.remove('active'));
  $('#pageTitle').textContent = '管理';
  $('#pageSub').textContent = '重置员工密码、查看初始密码名单与会话设备';
  $('#view').innerHTML = viewAdmin();
  $('#view').classList.add('wide');
  loadAdminPanels();
}
function loadAdminPanels() {
  const pw = $('#adminPwdList'), se = $('#adminSessList');
  if (pw) {
    api('/api/admin/initial-passwords').then(r => {
      if (!r.ok) { pw.innerHTML = `<div class="note">${esc(r.msg || '读不到名单')}</div>`; return; }
      if (!r.list.length) { pw.innerHTML = '<div class="note">没有人在用初始密码了。</div>'; return; }
      pw.innerHTML = r.list.map(x => `<div class="kv"><span>${esc(x.name)} · ${esc(x.no)}</span>
        <b>${x.neverLoggedIn ? '<span style="color:#b45309">从未登录</span>'
          : '首次登录 ' + esc((x.firstLoginAt || '').slice(0, 19).replace('T', ' ')) + ' · ' + esc(x.firstLoginIp || '')}
        <span class="btn link" data-act="admin-reset" data-no="${esc(x.no)}">重置为工号</span></b></div>`).join('');
    }).catch(err => { pw.innerHTML = `<div class="note">读取失败：${esc(err.message)}</div>`; });
  }
  if (se) {
    api('/api/admin/sessions').then(r => {
      if (!r.ok) { se.innerHTML = `<div class="note">${esc(r.msg || '读不到会话')}</div>`; return; }
      if (!r.list.length) { se.innerHTML = '<div class="note">当前没有登录会话。</div>'; return; }
      se.innerHTML = r.list.map(s => `<div class="kv"><span>${esc(s.name)} · ${esc(s.no)}</span>
        <b>${esc((s.last_seen || '').slice(0, 19).replace('T', ' '))} · ${esc(s.ip || '')}
        <span class="mini">${esc(String(s.ua || '').slice(0, 60))}</span></b></div>`).join('');
    }).catch(err => { se.innerHTML = `<div class="note">读取失败：${esc(err.message)}</div>`; });
  }
}
function render() {
  if (!S || !S.me) return;
  if (S.me.admin) return renderAdmin();
  document.body.classList.remove('admin-mode');
  $('#workdayPill').style.display = '';
  renderMe();
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const map = { today: viewToday, assign: viewAssign, routine: viewRoutine, special: viewSpecial, intake: viewIntake, calendar: viewCalendar, settings: viewSettings, task: viewTaskDetail };
  $('#view').innerHTML = (map[view] || viewToday)();
  $('#view').classList.toggle('wide', view === 'calendar');
  $('#pageTitle').textContent = TITLES[view] || '任务详情';
  $('#pageSub').textContent = view === 'calendar' ? '任务与待办统一在日历上安排' : '';
  const wd = isWorkday(TODAY);
  $('#workdayPill').textContent = `${fmtFull(TODAY)} · ${wd ? '工作日' : '非工作日'}`;
  $('#workdayPill').className = 'pill ' + (wd ? 'green' : 'warn');
  /* 角标算三样：等你立项的、分给你的子任务、派发后有变动的 */
  const n = S.intake.length + (S.stageIntake || []).length + (S.noticeGroups || []).length;
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
  renderAcct(me.name.slice(-1), me.name, `${me.dept} · ${me.role} · ${me.no}`);
}

/* 右上角账号区：谁在登录、改密码/退出都从这里进，不用先摸到侧边栏底部 */
function renderAcct(ava, name, meta) {
  const a = $('#topAva'), n = $('#topName');
  if (a) a.textContent = ava;
  if (n) n.textContent = name;
  const mn = $('#menuName'), mm = $('#menuMeta');
  if (mn) mn.textContent = name;
  if (mm) mm.textContent = meta;
}

function closeAcctMenu() {
  const menu = $('#acctMenu'), btn = document.querySelector('[data-act="acct-toggle"]');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/* 设置页里定位到改密码卡片：菜单点一次就到，不用在长页面里找 */
function goPassword() {
  closeAcctMenu();
  if (view !== 'settings') { view = 'settings'; render(); }
  const card = $('#pwdCard');
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1200);
  const inp = $('#pwd_old');
  if (inp) setTimeout(() => inp.focus(), 350);
}

/* 导出：走 fetch 才拿得到状态码——直接 location.href 的话，会话过期会整页跳成一坨 JSON。
   点下去先禁用并写「正在导出…」，成功/失败都回到按钮原样，用户知道点上了。 */
async function exportTasks() {
  const btn = $('#exportBtn');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '正在导出…'; }
  try {
    const res = await fetch('/api/export/tasks.csv');
    if (res.status === 401) { onAuthLost(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const fn = (cd.match(/filename="?([^";]+)"?/) || [])[1] || 'cadence-tasks.csv';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fn;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast(`已导出 ${Math.max(1, Math.round(blob.size / 1024))} KB · ${fn}`);
  } catch (e) {
    toast('导出失败：' + (e.message || '网络异常'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
/* ============ 任务详情（整页，不用抽屉） ============ */
/* 左抽屉只有 460px 宽，一列控件往下堆；管理者点开一条任务想看的是「到哪了、卡在哪」，
   不是一列要填的表单。所以改成整页：抬头先给进度，左边看阶段，右边才是字段；
   别人的任务整块只读，用键值表展示，不摆一堆改不动的灰控件。 */
let detailId = null, detailFrom = 'today';

function openTaskPage(id) {
  const t = S.tasks.find(x => x.id === id);
  if (!t) return;
  if (view !== 'task') detailFrom = view;
  detailId = id;
  view = 'task';
  render();
  window.scrollTo(0, 0);
}
function closeTaskPage() {
  detailId = null;
  view = detailFrom || 'today';
  render();
  if (pendingRefresh) { pendingRefresh = false; refresh(true).catch(() => { }); }
}

function viewTaskDetail() {
  const t = S.tasks.find(x => x.id === detailId);
  if (!t) {
    return `<div class="card"><div class="note">这条任务已经被删除了，或者你现在没有权限看它。</div>
      <div style="margin-top:12px"><button class="btn sm" data-act="close">← 返回</button></div></div>`;
  }
  return taskDetailHTML(t);
}

function taskDetailHTML(t) {
  const isRoutine = t.type === 'routine';
  const rule = S.rules.find(r => r.id === t.routineId) || null;
  /* 编辑权只看 owner。发布人把活交出去之后是只读，只剩总截止能动；
     子任务责任人更窄：只能勾自己那一段。 */
  const canEdit = t.ownerNo === S.me.no;
  /* 「加入待办」出来的那条是承接人某一段的派生副本：完成之外都归承接人。 */
  const isMirror = !!(t.stageRef && t.stageRef.taskId);
  const canPlan = canEdit && !isMirror;
  const pub = t.publisherNo || t.ownerNo;
  const imPublisher = pub === S.me.no;
  const stages = t.stages || [];
  const mySubs = stages.filter(s => s.pid && s.who === S.me.no && s.whoAt);
  const toDispatch = stages.filter(s => s.pid && s.who && !s.whoAt);
  const leaves = leavesOf(stages);
  const doneN = leaves.filter(s => s.done).length;
  const prog = taskProg(t);
  const leftDays = diffDays(t.end, TODAY);
  const src = t.sourceId ? (S.tasks.find(i => i.id === t.sourceId) || null) : null;
  const stOpts = Object.keys(ST).map(k => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${ST[k].name}</option>`).join('');
  const lvOpts = v => `<option value="">未设置</option>` + [3, 2, 1].map(k => `<option value="${k}" ${v === k ? 'selected' : ''}>${LV[k]}</option>`).join('');
  const whoOpts = assigneeOptions(t.assigneeNo);

  const leftText = t.status === 'done' ? '已完成'
    : leftDays > 0 ? `还有 ${leftDays} 天` : leftDays === 0 ? '今天到期' : `逾期 ${-leftDays} 天`;

  /* ---- 抬头：返回 + 标题 + 标签，再一排进度指标 ---- */
  const head = `<div class="td-head">
      <button class="btn sm ghost" data-act="close">← 返回</button>
      <div style="flex:1;min-width:0">
        <input id="dTitle" value="${esc(t.title)}" data-field="title" ${canPlan ? '' : 'readonly'}
          class="td-title${canPlan ? '' : ' ro'}"/>
        <div class="split" style="margin-top:6px">${typeChip(t)}${stTag(t.status)}${prioBadge(t)}${overdue(t) ? '<span class="tag red">已逾期</span>' : ''}
          ${t.ownerNo !== S.me.no ? `<span class="tag">${esc(nameOf(t.ownerNo))} 承接</span>` : ''}
          ${imPublisher && t.ownerNo !== S.me.no ? '<span class="tag">你发布</span>' : ''}
          ${canEdit ? '' : (mySubs.length ? '<span class="tag">你负责其中一段</span>' : '<span class="tag">只读</span>')}
          ${isMirror ? `<span class="tag">${esc(nameOf(t.ownerNo))} 派给你的一段</span>` : ''}
        </div>
      </div>
    </div>
    <div class="td-kpis">
      <div><span>进度</span><b>${prog}%</b><div class="prog" style="margin-top:8px"><i style="width:${prog}%"></i></div></div>
      <div><span>${isRoutine ? '当天节点' : '完成'}</span><b>${leaves.length ? `${doneN} / ${leaves.length}` : '—'}</b></div>
      <div><span>${t.ownerNo === S.me.no ? '距截止' : '总截止'}</span><b style="font-size:15px">${t.ownerNo === S.me.no ? leftText : fmt(t.dueDate || t.end)}</b></div>
      <div><span>承接人</span><b style="font-size:15px">${t.assigneeNo === S.me.no ? '我' : esc(nameOf(t.assigneeNo))}</b></div>
    </div>`;

  /* ---- 左栏：阶段 / 节点 ---- */
  const stageCard = isRoutine
    ? `<div class="card"><div class="card-h"><h2>本周期节点</h2><span class="hint">${t.status === 'done' ? '已完成' : '勾掉即完成'}</span></div>
        ${stages.length ? `<div class="stagelist">${stages.map((s, i) => `<div class="sitem">
          <div class="cb ${s.done ? 'on' : ''}" ${canEdit ? `data-act="toggle-step" data-id="${t.id}" data-idx="${i}"` : ''}>${s.done ? '✓' : ''}</div>
          <div class="nm ${s.done ? 'done' : ''}"><span style="text-decoration:${s.done ? 'line-through' : 'none'}">${esc(s.name || '执行')}</span>
            <small>${fmt(s.date)}${s.time ? ' · ' + s.time : ''}${s.plan && s.plan !== s.date ? ` · 计划 ${fmt(s.plan)}，节假日已调整` : ''}</small></div>
        </div>`).join('')}</div>` : '<div class="mini">这一天没有设节点</div>'}
        ${rule
          ? `<div class="note" style="margin-top:10px">由常规规则「${esc(rule.title)}」自动生成 · ${fmt(t.start)} ~ ${fmt(t.end)}
              ${canEdit && t.planDate && t.planDate !== t.start ? `<br/>因节假日已调整到 <b>${fmt(t.start)}</b>，<span class="btn link" data-act="stage-restore" data-id="${t.id}">恢复规则日期</span>` : ''}
              ${canEdit ? `<br/><button class="btn link" data-act="rule-edit" data-id="${t.routineId}">编辑这条规则</button>` : `<br/>这是${esc(nameOf(t.ownerNo))}的常规安排，你只能看`}</div>`
          : `<div class="note" style="margin-top:10px">所属规则「${esc(t.title)}」<b>已删除</b>，这条是保留下来的历史记录，不会再有新的。</div>`}
      </div>`
    : `<div class="card"><div class="card-h"><h2>阶段计划</h2>
        <span class="hint">${leaves.length ? `${doneN} / ${leaves.length} 已完成，进度按最细一级算` : '还没拆阶段'}</span></div>
        ${canPlan ? `<div class="note" id="dispatchNote" style="margin-bottom:10px;${toDispatch.length ? '' : 'display:none'}">
          <b>有 ${toDispatch.length} 段已经指定了责任人，但还没派发</b>——派发之前，对方那边什么都看不到。
          <button class="btn primary sm" style="margin-left:8px" data-act="task-dispatch" data-id="${t.id}">派发</button></div>` : ''}
        ${stages.length ? stageTreeHTML(t, canPlan) : (isMirror
          ? '<div class="mini">这段的计划由承接人维护，你只需要做完后勾完成。</div>'
          : '<div class="mini">大活儿建议拆成 2~5 段，进度就会按阶段自动算，不用手填百分比。</div>')}
        ${canPlan ? `<div style="margin-top:12px;border-top:1px dashed var(--line);padding-top:12px">
          <div class="sec-title" style="margin:0 0 7px">再加一段 <span class="mini">名称写清这一段交付什么</span></div>
          <input id="sName" placeholder="例如：数据口径确认与取数" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:7px 9px;font-size:12.5px;font-family:inherit;margin-bottom:6px"/>
          <div class="row">
            <input type="date" id="sStart" value="${t.start}" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12px"/>
            <input type="date" id="sEnd" value="${t.end}" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:12px"/>
            <button class="btn primary sm" data-act="stage-add" data-id="${t.id}">添加</button>
          </div>
          <div class="mini" style="margin-top:7px;line-height:1.5">改哪一段，点它右边的「改」；某一段要别人做，点「+ 子任务」拆一层，选上谁做。子任务只能再拆一层。</div>
        </div>` : ''}
      </div>`;

  /* ---- 右栏：能改就用表单，不能改就用键值表（管理者看别人的活，要的是读数不是控件） ---- */
  const assigneeField = t.type === 'assign'
    ? `<select data-field="assigneeNo">${whoOpts}</select>`
    : `<div class="locked">${esc(nameOf(t.assigneeNo))}${t.assigneeNo === S.me.no ? '（本人）' : ''}<span class="mini">不可改</span></div>
       <div class="mini" style="margin-top:5px;line-height:1.5">整件事要交给别人，去「发布任务」新建一条；只想把其中一段分给同事，在左边的阶段里拆子任务、选上谁做就行。</div>`;

  const infoCard = canPlan ? `<div class="card"><div class="card-h"><h2>任务信息</h2><span class="hint">改完即存</span></div>
        <div class="field"><label>状态</label><select data-field="status">${stOpts}</select></div>
        <div class="field"><label>起止时间</label><div class="row">
          <input type="date" value="${t.start}" data-field="start"/>
          <input type="date" value="${t.end}" data-field="end"/>
        </div>
        ${!isRoutine && imPublisher ? `<div class="mini" style="margin-top:5px;line-height:1.5">总截止 ${fmt(t.dueDate || t.end)}：这是你对发布对象的承诺，改它要单独确认</div>` : ''}
        </div>
        ${isRoutine ? '' : `<div class="field"><label>时间点（可选）</label><input type="time" value="${t.time || ''}" data-field="time"/></div>
        <div class="field"><label>承接人</label>${assigneeField}</div>
        <div class="field"><label>达成标准</label><textarea data-field="std" placeholder="写清楚什么算完成">${esc(t.std || '')}</textarea></div>
        ${catInputsHTML(t.cat1, t.cat2, 'd')}
        <div class="field"><label>优先级（可选填）</label><div class="row">
          <select data-field="imp">${lvOpts(t.imp).replace('未设置', '重要度：未设置')}</select>
          <select data-field="urg">${lvOpts(t.urg).replace('未设置', '紧急度：未设置')}</select>
        </div></div>`}
      </div>`
    : isMirror
      ? `<div class="card"><div class="card-h"><h2>任务信息</h2><span class="hint">计划由承接人维护</span></div>
        <div class="field"><label>完成情况</label><select data-field="status">${stOpts}</select></div>
        <div class="kv"><span>谁派的</span><b>${esc(nameOf(t.ownerNo))}</b></div>
        <div class="kv"><span>计划起止</span><b>${fmt(t.start)}${t.time ? ' ' + t.time : ''} → ${fmt(t.end)}</b></div>
        <div class="kv"><span>达成标准</span><b style="font-weight:500;text-align:right">${esc(t.std || '未填写')}</b></div>
        <div class="kv"><span>分类</span><b>${catName(t.cat1, t.cat2)}</b></div>
        <div class="kv"><span>优先级</span><b>${prioLabel(t) || '未设置'}</b></div>
        <div class="mini" style="margin-top:8px;line-height:1.5">标题和日期归承接人，要调期找他；你勾完成，他那边会同步看到。</div>
      </div>`
      : `<div class="card"><div class="card-h"><h2>任务信息</h2><span class="hint">只读</span></div>
        <div class="kv"><span>状态</span><b>${ST[t.status] ? ST[t.status].name : '—'}</b></div>
        <div class="kv"><span>承接人</span><b>${esc(nameOf(t.assigneeNo))}</b></div>
        <div class="kv"><span>发布人</span><b>${esc(nameOf(pub))}</b></div>
        <div class="kv"><span>总截止</span><b>${fmt(t.dueDate || t.end)}${
          imPublisher ? ` <button class="btn sm ghost" data-act="due-set" data-id="${t.id}">改</button>` : ''
        }</b></div>
        <div class="kv"><span>计划起止</span><b>${fmt(t.start)}${t.time ? ' ' + t.time : ''} → ${fmt(t.end)}</b></div>
        <div class="kv"><span>达成标准</span><b style="font-weight:500;text-align:right">${esc(t.std || '未填写')}</b></div>
        <div class="kv"><span>分类</span><b>${catName(t.cat1, t.cat2)}</b></div>
        <div class="kv"><span>优先级</span><b>${prioLabel(t) || '未设置'}</b></div>
      </div>`;

  /* ---- 底部：来源链路 + 删除 ---- */
  const srcLine = src
    ? (imPublisher ? `这是你发布的「${esc(src.title || '')}」的旧版承接副本` : `来源：${esc(nameOf(src.ownerNo))} 发布的「${esc(src.title || '')}」`)
    : (imPublisher && t.ownerNo !== S.me.no ? `你发布的，已移交 ${esc(nameOf(t.ownerNo))}——之后怎么干由他定，你只看进度` : '');
  const roWhy = mySubs.length
    ? `你负责其中 ${mySubs.length} 段，只能勾自己那段的完成；计划由 ${esc(nameOf(t.ownerNo))} 排`
    : (imPublisher ? '这条已经交出去了，你只能看进度；要改总截止点「改」' : '你没有这条任务的编辑权');
  const mirrorWhy = isMirror ? `这段由 ${esc(nameOf(t.ownerNo))} 派给你：计划归他维护，你只勾完成` : '';
  const foot = `<div class="td-foot">
      <div class="mini" style="line-height:1.6">${srcLine ? srcLine + '<br/>' : ''}分类 ${catName(t.cat1, t.cat2)} · 进度 ${prog}%${canEdit ? (mirrorWhy ? ' · ' + mirrorWhy : '') : ' · ' + roWhy}</div>
      ${!isRoutine && canPlan ? `<button class="btn danger" data-act="task-del" data-id="${t.id}">删除这条任务</button>` : ''}
    </div>`;

  /* ---- 知情人：专项任务才有。看得到进展，改不了任何东西 ---- */
  const obsList = t.observers || [];
  const obsCard = (t.type === 'special' && (obsList.length || canEdit))
    ? `<div class="card">
        <div class="card-h"><h2>知情人</h2><span class="hint">${canEdit ? '他们能在「发布任务」页看到这条专项的进度' : '你只能看进度'}</span></div>
        ${obsList.length ? obsList.map(no => `<div class="kv"><span>${esc(nameOf(no))}</span>${
          canEdit ? `<b><button class="btn sm ghost" data-act="obs-del" data-id="${t.id}" data-no="${no}">移除</button></b>` : '<b>知情</b>'}</div>`).join('')
          : '<div class="mini">还没有指定知情人</div>'}
        ${canEdit ? `<div style="margin-top:10px">
          <select data-act="obs-add" data-id="${t.id}">
            <option value="">+ 添加知情人</option>
            ${(S.roster || []).filter(e => e.no !== S.me.no && !obsList.includes(e.no))
              .map(e => `<option value="${e.no}">${esc(e.name)}（${esc(e.role || '')}）${e.activated ? '' : ' · 未登录过'}</option>`).join('')}
          </select>
          <div class="mini" style="margin-top:6px;line-height:1.4">知情人只看不改。他还没登录过工作台也不影响——知情是知会一声。</div>
        </div>` : ''}
      </div>` : '';

  return head + `<div class="grid-2"><div>${stageCard}</div><div>${infoCard}${obsCard}</div></div>` + foot;
}
/* 「谁做」的选项。新建弹窗、详情页行内、「改」表单三处共用这一份——
   上次就是三处各写各的：弹窗写「承接人自己做」、详情页写「承接人自己做（张三）」、
   「改」表单里压根没有，结果同一个词在三个地方三种说法。 */
function whoOptionsHTML(ownNo, cur) {
  const own = ownNo ? nameOf(ownNo) : '';
  return [`<option value="" ${cur ? '' : 'selected'}>${own ? `承接人自己做（${esc(own)}）` : '承接人自己做'}</option>`]
    .concat((S.roster || [])
      .filter(e => e.no !== ownNo && e.activated)
      .map(e => `<option value="${e.no}" ${cur === e.no ? 'selected' : ''}>${esc(e.name)}${S.subs.some(x => x.no === e.no) ? '' : ' · 非下属'}</option>`))
    .join('');
}
function stageWhoOptions(t, cur) { return whoOptionsHTML(t.assigneeNo, cur); }

/* 弹窗里承接人还没落库，读的是当前选中的那个人；读不到就是自己 */
function draftAssignee() {
  const el = document.getElementById('f_assignee');
  return (el && el.value) || S.me.no;
}

/* 子任务那一段的状态。没指定人就没有这一段，不占地方。 */
function stageTagHTML(s) {
  if (!s.who) return '';
  if (!s.whoAt) return '<span class="tag warn">未派发</span>';
  if (!s.joinedAt) return '<span class="tag">已派发 · 待加入</span>';
  return '<span class="tag done">已加入待办</span>';
}

/* 换人：只改这一行 + 顶部那条派发提示，不整页重绘。
   整页重绘会把用户刚拨开的下拉一起销毁，看起来就像「选了没反应」。
   quiet 给「改」表单用：那边紧接着就整页重绘了，不用在这儿再刷一遍。 */
function setStageWho(t, idx, no, sel, quiet) {
  const s = (t.stages || [])[idx];
  if (!s) return false;
  const v = no || null;
  if (v && !empActivated(v)) {
    toast(`${nameOf(v)} 还没有登录过工作台，子任务派过去他收不到。`);
    if (sel) sel.value = s.who || '';
    return false;
  }
  if ((s.who || null) === v) return true;
  /* 换人必须重新派发、重新加入待办：服务端也会清，这里同步清一遍，
     否则界面上会显示「已派发」其实那边什么都没收到。 */
  s.who = v; s.whoAt = null; s.joinedAt = null;
  if (quiet) return true;
  save();
  const tag = document.querySelector(`#view .subtag[data-tag="${idx}"]`);
  if (tag) tag.outerHTML = `<span class="subtag" data-tag="${idx}">${stageTagHTML(s)}</span>`;
  refreshDispatchNote(t);
  toast(v ? `这段指定给 ${nameOf(v)}，点「派发」对方才收得到` : '已改回由承接人自己做');
  return true;
}

function refreshDispatchNote(t) {
  const n = (t.stages || []).filter(s => s.pid && s.who && !s.whoAt).length;
  const box = document.querySelector('#view #dispatchNote');
  if (!box) return;
  box.style.display = n ? '' : 'none';
  const b = box.querySelector('b');
  if (b) b.textContent = `有 ${n} 段已经指定了责任人，但还没派发`;
}

/* 阶段树：一级阶段带序号，子任务缩进一级。
   父阶段有子任务时不给勾选框——点了就是「全勾/全不勾」，容易误解；它的完成态由子任务决定。
   责任人只挂在子任务上：阶段是「一段时间」，子任务才是「一件能勾的活」。 */
function stageTreeHTML(t, canEdit) {
  const stages = t.stages || [];
  const tops = stages.filter(s => !s.pid);
  const myTick = s => s.who ? (s.who === S.me.no && s.whoAt) : canEdit;
  const whoSel = (s, idx) => `<select class="who-sel" data-act="stage-who" data-id="${t.id}" data-idx="${idx}"
    title="这一段由谁来做">${stageWhoOptions(t, s.who || '')}</select>`;
  let n = 0;
  return tops.map(p => {
    n++;
    const pi = stages.indexOf(p);
    const kids = kidsOf(stages, p.id);
    const pDone = kids.length ? kids.every(k => k.done) : p.done;
    const canTickP = canEdit && !kids.length;
    const head = `<div class="stage ${pDone ? 'on' : ''}">
      <div class="n" ${canTickP ? `data-act="stage-toggle" data-id="${t.id}" data-idx="${pi}" style="cursor:pointer"` : ''}>${pDone ? '✓' : n}</div>
      <div class="t ${pDone ? 'done' : ''}"><span class="sn" style="text-decoration:${pDone ? 'line-through' : 'none'}">${esc(p.name)}</span>${p.start || p.end ? `<small>${fmt(p.start)} → ${fmt(p.end)}${kids.length ? ` · 含 ${kids.length} 个子任务` : ''}</small>` : ''}</div>
      ${canEdit ? `<button class="btn sm ghost" data-act="stage-edit" data-id="${t.id}" data-idx="${pi}" title="改这一段的名称和日期">改</button>` : ''}
      ${canEdit ? `<button class="btn sm ghost" data-act="stage-sub" data-id="${t.id}" data-idx="${pi}" title="在这个阶段下加子任务；子任务是唯一能指定责任人的层级">+ 子任务</button>` : ''}
      ${canEdit ? `<button class="btn sm ghost" data-act="stage-del" data-id="${t.id}" data-idx="${pi}">删</button>` : ''}
    </div>`;
    /* 子行只留三类信息：编号、名称+日期、谁做（下拉与状态挨在一起，是一件事）。
       人名不再单独写一遍——下拉里已经有了，写两遍只会让人以为哪处能改哪处不能。 */
    const sub = kids.map((k, order) => {
      const ki = stages.indexOf(k);
      const tick = myTick(k);
      return `<div class="stage sub ${k.done ? 'on' : ''}">
        <div class="n" ${tick ? `data-act="stage-toggle" data-id="${t.id}" data-idx="${ki}" style="cursor:pointer"` : `title="${k.who ? `由 ${esc(nameOf(k.who))} 负责，完成由他勾` : '这段由别人负责'}"`} >${k.done ? '✓' : `${n}.${order + 1}`}</div>
        <div class="t ${k.done ? 'done' : ''}"><span class="sn" style="text-decoration:${k.done ? 'line-through' : 'none'}">${esc(k.name)}</span>${k.start || k.end ? `<small>${fmt(k.start)} → ${fmt(k.end)}</small>` : ''}</div>
        ${canEdit ? `<span class="subtag" data-tag="${ki}">${stageTagHTML(k)}</span>` : `<span class="subtag" data-tag="${ki}">${stageTagHTML(k)}</span>${k.who ? `<span class="mini who-ro">${esc(nameOf(k.who))}</span>` : ''}`}
        ${canEdit ? whoSel(k, ki) : ''}
        ${canEdit ? `<button class="btn sm ghost" data-act="stage-edit" data-id="${t.id}" data-idx="${ki}" title="改这一段的名称、日期和谁做">改</button>` : ''}
        ${canEdit ? `<button class="btn sm ghost" data-act="stage-del" data-id="${t.id}" data-idx="${ki}">删</button>` : ''}
      </div>`;
    }).join('');
    return head + sub;
  }).join('');
}

/* 分类是手填的两个文本框，不做统一维护：写过的分类自动成为输入提示。
   sfx 用来区分同时存在的几份表单（详情页 / 新建弹窗 / 规则弹窗），避免 datalist 撞 id。 */
function catInputsHTML(c1, c2, sfx) {
  const s = sfx || 'd';
  /* 提示项 = 分类表里有的 + 任务里真用过的，清空分类表后照样有东西可选 */
  const used1 = new Set(), used2 = new Set();
  S.tasks.forEach(t => {
    const a = catLabel(t.cat1), b = catLabel(t.cat2);
    if (a) used1.add(a);
    if (b) used2.add(b);
  });
  const l1 = [...new Set([...S.cats.map(c => c.name), ...used1])].filter(Boolean);
  const l2 = [...new Set([...S.cats.flatMap(c => (c.children || []).map(k => k.name)), ...used2])].filter(Boolean);
  return `<div class="field"><label>任务分类 <span class="mini">手填，可留空</span></label>
    <div class="row">
      <input data-field="cat1" list="catL1-${s}" value="${esc(catLabel(c1))}" placeholder="一级，例如：业务交付"/>
      <input data-field="cat2" list="catL2-${s}" value="${esc(catLabel(c2))}" placeholder="二级，例如：数据与报表"/>
    </div>
    <datalist id="catL1-${s}">${l1.map(x => `<option value="${esc(x)}"></option>`).join('')}</datalist>
    <datalist id="catL2-${s}">${l2.map(x => `<option value="${esc(x)}"></option>`).join('')}</datalist>
  </div>`;
}
const otherCat = () => ({ c1: '其他', c2: '临时事项' });
function catInputVal(root, field) {
  const el = document.querySelector(`${root} [data-field="${field}"]`);
  return el ? (el.value.trim() || null) : null;
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
let modalSnap = '';
let nudgeTimer = 0;

/* 表单快照：用来判断「有没有填过东西」。
   只比控件值和勾选状态；阶段行增删天然改变控件数量，也算改过。 */
function modalSnapshot() {
  const root = $('#modal');
  if (!root) return '';
  return [...root.querySelectorAll('input,select,textarea')]
    .map((el, i) => [i, el.type || '', el.id || '', el.value || '', el.checked ? 1 : 0].join('\u0001'))
    .join('\u0002');
}
function modalDirty() { return modalSnapshot() !== modalSnap; }

function openModal(title, body, onOk, okText) {
  modalOk = onOk;
  $('#modal').className = 'modal';
  $('#modal').innerHTML = `<div class="mh">${esc(title)}</div><div class="mb">${body}</div>
    <div class="mf"><button class="btn" data-act="modal-cancel">取消</button>
    <button class="btn primary" data-act="modal-ok">${okText || '保存'}</button></div>`;
  $('#modalWrap').classList.add('show');
  modalSnap = modalSnapshot();
}

/* 点了遮罩/按了 Esc：没填过东西就直接关（顺手），填过了就别关——
   直接关等于把用户敲的半分钟内容烧了，这是最不该省的那一下确认。 */
function tryCloseModal() {
  if (!modalDirty()) { closeModal(); return; }
  const m = $('#modal');
  m.classList.remove('shake');
  void m.offsetWidth;
  m.classList.add('shake');
  const box = $('#modal .mb');
  if (box) {
    let tip = $('#modalNote');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'modalNote';
      tip.className = 'mnote';
      box.appendChild(tip);
    }
    tip.textContent = '内容还没保存：要留下就点「保存」，确实不要了点「取消」';
    tip.scrollIntoView({ block: 'nearest' });
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { const x = $('#modalNote'); if (x) x.remove(); }, 4000);
  }
}

function closeModal() {
  $('#modalWrap').classList.remove('show');
  $('#modal').classList.remove('shake');
  const tip = $('#modalNote'); if (tip) tip.remove();
  clearTimeout(nudgeTimer);
  modalSnap = '';
  modalOk = null;
  if (pendingRefresh) { pendingRefresh = false; refresh(true).catch(() => { }); }
}

/* 承接人：只有「发布任务」能指定给别人。
   专项、临时一律是本人——这两个页面不是派活入口，锁住才不会让人以为能给他人派活。 */
function canAssignOthers(type) { return type === 'assign'; }

/* 承接人下拉：全员可选，分「我的下属 / 其他同事」两组。
   发布是点名派的活，本来就不靠汇报关系，所以不再只列直接下属；
   从没登录过工作台的人标出来——派给他他收不到，别让人以为派出去就有人接了。 */
function empActivated(no) {
  const e = (S.roster || []).find(x => x.no === no);
  return e ? !!e.activated : false;
}
function empOptionLabel(e, isSub) {
  return `${e.name}（${e.role || ''}）${isSub ? '' : '· 非下属'}${e.activated ? '' : ' · 未登录过'}`;
}
function assigneeOptions(sel) {
  const me = S.me.no;
  const subNos = new Set(S.subs.map(m => m.no));
  const roster = S.roster || [];
  const opt = (e, isSub) => `<option value="${e.no}" ${sel === e.no ? 'selected' : ''}>${esc(empOptionLabel(e, isSub))}</option>`;
  const subs = roster.filter(e => subNos.has(e.no));
  const others = roster.filter(e => e.no !== me && !subNos.has(e.no));
  return `<option value="${me}" ${!sel || sel === me ? 'selected' : ''}>我</option>`
    + (subs.length ? `<optgroup label="我的下属">${subs.map(e => opt(e, true)).join('')}</optgroup>` : '')
    + (others.length ? `<optgroup label="其他同事">${others.map(e => opt(e, false)).join('')}</optgroup>` : '');
}

function assigneeFieldInner(type, sel) {
  if (canAssignOthers(type)) {
    const cross = sel && sel !== S.me.no && !S.subs.some(m => m.no === sel);
    return `<div class="field"><label>承接人</label><select id="f_assignee">${assigneeOptions(sel)}</select>
      ${cross ? `<div class="mini" style="margin-top:5px;line-height:1.4">${esc(nameOf(sel))} 不是你的直接下属。这条活是点名派给他的，他登录后就能在承接台看到。</div>` : ''}
      <div class="mini" style="margin-top:5px;line-height:1.4">标着「未登录过」的人还从没打开过工作台，任务派过去他收不到，不能派给他。</div>
    </div>`;
  }
  return `<div class="field"><label>承接人</label>
    <div class="locked">我（本人）<span class="mini">不可改</span></div>
    <div class="mini" style="margin-top:5px;line-height:1.5">这类事归自己办。整件事要交给别人，用「发布任务」；只想把其中一段分出去，建好之后在阶段里拆子任务、选上谁做。</div>
    <input type="hidden" id="f_assignee" value="${S.me.no}"/>
  </div>`;
}

function assigneeFieldHTML(type, sel) {
  return `<div id="fAssigneeWrap">${assigneeFieldInner(type, sel)}</div>`;
}

/* ============ 知情人（专项任务） ============ */
/* 知情人＝知道这个项目在推进、但不是执行人。他们能在「发布任务」页的「我关注的任务」里看到进度。
   现在按自由选择做：全员可选、可搜索、多选。
   没登录过工作台的人照样能选——知情是「知会一声」，不依赖对方账号；
   真正依赖对方能不能收得到的是「发布」，那个才拦。 */
let obsPicked = [];
function observerCandidates(kw) {
  const k = String(kw || '').trim().toLowerCase();
  return (S.roster || []).filter(e => e.no !== S.me.no)
    .filter(e => !k || String(e.no).toLowerCase().includes(k)
      || String(e.name || '').toLowerCase().includes(k)
      || String(e.role || '').toLowerCase().includes(k)
      || String(e.dept || '').toLowerCase().includes(k));
}
function renderObserverList(kw) {
  const list = $('#f_obs_list');
  if (!list) return;
  const rows = observerCandidates(kw);
  list.innerHTML = rows.length ? rows.map(e => `<label class="obs-row${obsPicked.includes(e.no) ? ' on' : ''}">
      <input type="checkbox" data-no="${e.no}" ${obsPicked.includes(e.no) ? 'checked' : ''}/>
      <span class="nm">${esc(e.name)}</span>
      <span class="mini">${esc(e.role || '')} · ${esc(e.no)}</span>
      ${e.activated ? '' : '<span class="mini warn">未登录过</span>'}
    </label>`).join('')
    : '<div class="mini" style="padding:8px 2px">没有匹配的人</div>';
  const tip = $('#f_obs_picked');
  if (tip) tip.textContent = obsPicked.length
    ? `已选 ${obsPicked.length} 人：${obsPicked.map(no => esc(nameOf(no))).join('、')}`
    : '还没选人';
  const hidden = $('#f_observers');
  if (hidden) hidden.value = obsPicked.join(',');
}
function observerFieldHTML(type) {
  return `<div class="field" id="fObsWrap" style="display:${type === 'special' ? '' : 'none'}">
    <label>知情人 <span class="mini">可多选；他们能在「发布任务」页看到这条专项的进度</span></label>
    <input id="f_obs_kw" placeholder="搜索工号、姓名、岗位或部门" autocomplete="off"/>
    <div id="f_obs_list" class="obs-list"></div>
    <div class="mini" id="f_obs_picked">还没选人</div>
    <input type="hidden" id="f_observers" value=""/>
    <div class="mini" style="margin-top:5px;line-height:1.4">知情人只是知道进展，不参与执行，也不能改这条任务。没登录过工作台的人也能选。</div>
  </div>`;
}

function taskModalBody(type, preset) {
  const today = (preset && preset.date) || TODAY;
  const base = `
  <div class="field"><label>任务名称</label><input id="f_title" placeholder="例如：季度经营分析报告" value="${preset && preset.title ? esc(preset.title) : ''}"/></div>
  <div class="field"><label>任务类型</label>
    <div class="locked" id="f_type_lock">${TYPES[type].name}<span class="mini">按你从哪个页面点「新建」自动定，不用选</span></div>
  </div>
  ${assigneeFieldHTML(type, preset && preset.assigneeNo)}
  <div class="field"><label>起止时间 / 时间点（可选）</label><div class="row">
    <input type="date" id="f_start" value="${today}" style="flex:1"/>
    <input type="date" id="f_end" value="${today}" style="flex:1"/>
    <input type="time" id="f_time" style="flex:0 0 96px"/>
  </div></div>
  <div class="field"><label>达成标准</label><textarea id="f_std" placeholder="什么算完成，验收看什么">${preset && preset.std ? esc(preset.std) : ''}</textarea></div>
  ${catInputsHTML(type === 'temp' ? otherCat().c1 : null, type === 'temp' ? otherCat().c2 : null, 'm')}
  <div class="field"><label>优先级（可选填，不填不影响使用）</label><div class="row">
    <select id="f_imp"><option value="">重要度</option>${[3, 2, 1].map(k => `<option value="${k}">${LV[k]}</option>`).join('')}</select>
    <select id="f_urg"><option value="">紧急度</option>${[3, 2, 1].map(k => `<option value="${k}">${LV[k]}</option>`).join('')}</select>
  </div></div>
  ${observerFieldHTML(type)}`;

  if (type === 'temp') {
    return base + `<div class="note">临时任务默认归入「其他 / 临时事项」，起止可只选今天。</div>`;
  }
  /* 发布时就该能拆完、点完人——领导发一个任务，其中很多子任务要别人做，
     等他接过来再派人，这条链就长了。所以 assign 和 special 共用这套阶段区。 */
  return `<div class="form-grid">
    <div class="form-col">
      <div class="sec-title">基本信息</div>
      ${base}
    </div>
    <div class="form-col">
      <div class="sec-title">阶段与分工 <span class="mini">可留空，之后再补</span></div>
      <div class="mini" style="margin:-4px 0 9px;line-height:1.55">按时间把这件事分成几段（阶段）；某一段要别人做，点那段的「+子」拆成子任务，选上谁做。</div>
      <div id="stageRows">${stageRowHTML(today, today)}</div>
      <button class="btn sm" data-act="mstage-add" style="width:100%">+ 添加阶段</button>
      <div class="note" style="margin-top:10px">子任务选上人之后，还要点任务上的「派发」，对方才会在承接台收到；派发之前随便改，他那边什么都看不到。</div>
    </div>
  </div>`;
}
/* 弹窗里的阶段行：pid 为空是一级阶段，有值是它的子任务。
   data-tmp 是这一行的临时 id，保存时直接当节点 id 用（uid 保证唯一），这样子任务才有父可指。
   每行前面那个编号是后填的（renumberStageRows）：两个名字框长一样，只有编号能让人一眼分清
   这是第几段、还是第几段下面的第几个子任务。 */
function stageRowHTML(s, e, pid) {
  const isSub = !!pid;
  return `<div class="mrow${isSub ? ' sub' : ''}" data-tmp="${uid('s')}" data-pid="${pid || ''}">
    <div class="mrow-h">
      <span class="sno"></span>
      <input class="sname" placeholder="${isSub ? '这段具体做什么，例如：取数并核对口径' : '这一段做什么，例如：数据口径确认与取数'}"/>
    </div>
    <div class="row2">
      <input type="date" class="sst" value="${s}"/>
      <input type="date" class="sen" value="${e}"/>
      ${isSub ? `<span class="lbl2">谁做</span><select class="swho" title="这段由谁做；不选就是承接人自己做">${whoOptionsHTML(draftAssignee(), '')}</select>` : `<button class="addsub" data-act="mstage-sub" title="在这个阶段下加子任务">+ 子任务</button>`}
      <button class="del" data-act="mstage-del" title="删除">✕</button>
    </div>
  </div>`;
}
/* 编号只跟 DOM 顺序走，不存库：删掉一段、调一次顺序，重新数一遍就行。 */
function renumberStageRows() {
  const marks = new Map();
  let n = 0;
  $$('#stageRows .mrow').forEach(r => {
    const badge = r.querySelector('.sno');
    if (!badge) return;
    if (!r.dataset.pid) {
      n++;
      marks.set(r.dataset.tmp, { n, k: 0 });
      badge.textContent = n;
    } else {
      const p = marks.get(r.dataset.pid);
      if (p) badge.textContent = `${p.n}.${++p.k}`;
      else badge.textContent = String(++n);   /* 父行已被删掉的孤儿，按一级显示 */
    }
  });
}
/* 从弹窗读回阶段树。父阶段的日期就是表单里填的那些，不从子任务反推：
   弹窗里阶段行和子任务行各有各的日期输入框，谁填的就是谁的。
   父行名字没填被丢掉时，挂在它下面的子任务不能变孤儿，一律按一级处理。 */
function readStageRows(fallback) {
  const out = $$('#stageRows .mrow').map(r => {
    const name = r.querySelector('.sname').value.trim();
    if (!name) return null;
    const st = r.querySelector('.sst').value || fallback;
    let en = r.querySelector('.sen').value || st;
    if (en < st) en = st;
    const whoEl = r.querySelector('.swho');
    return { id: r.dataset.tmp || uid('s'), pid: r.dataset.pid || null, name, start: st, end: en, done: false, who: whoEl ? (whoEl.value || null) : null };
  }).filter(Boolean);
  const tops = new Set(out.filter(x => !x.pid).map(x => x.id));
  out.forEach(x => { if (x.pid && !tops.has(x.pid)) x.pid = null; });
  return out;
}
function openNewTask(type, preset) {
  const t = type || 'temp';
  /* 类型不再在弹窗里改，但「承接人决定它是什么」：
     派给别人 = 发布任务（等他接收），派给自己 = 一条专项（直接进我的专项工作）。
     两者其实是同一件事的两种归属，所以只留一个入口，别做两套几乎一样的表单。 */
  openModal(t === 'assign' ? '发布任务' : `新建${TYPES[t].name}`, taskModalBody(t, preset), () => {
    const title = $('#f_title').value.trim();
    if (!title) { toast('先填任务名称'); return false; }
    const s = $('#f_start').value, e = $('#f_end').value || s;
    if (!s) { toast('请选择开始时间'); return false; }
    if (e < s) { toast('结束时间不能早于开始时间'); return false; }
    const stages = readStageRows(s);
    /* 新建弹窗读回阶段树之后也走同一套校验：这里的「阶段」以前只重算父阶段并集，
       同层重叠、重名、超截止统统放过，等于绕开后面所有入口。 */
    const draft = { stages: [], type: t, dueDate: e };
    const vStage = validateStages(draft, stages, { action: 'new', checkDupAll: true });
    if (!vStage.ok) { toast(vStage.msg); return false; }
    /* 任务周期 = 一级阶段的包络：弹窗里阶段日期改了但起止没跟着改的话，
       存下去就是「任务 7月3日–11月6日，阶段却排到明年」——服务端会拒，这里先对齐。 */
    const span = { start: s, end: e };
    restatTaskSpan(span);
    const typeVal = t;
    const assigneeNo = canAssignOthers(typeVal) ? $('#f_assignee').value : S.me.no;
    /* 派给一个从没登录过工作台的人 = 白派：他收不到，任务躺在那里假装有进展。 */
    if (typeVal === 'assign' && assigneeNo !== S.me.no && !empActivated(assigneeNo)) {
      const e2 = (S.roster || []).find(x => x.no === assigneeNo);
      toast(`${e2 ? e2.name : '这个人'} 还没有登录过工作台，任务派过去他收不到。先让他登录一次，或者改派给别的同事。`);
      return false;
    }
    /* 子任务责任人也一样要拦：他只在承接台收到，没有别的渠道 */
    for (const st of stages) {
      if (!st.pid || !st.who) continue;
      if (!empActivated(st.who)) {
        toast(`${nameOf(st.who)} 还没有登录过工作台，子任务派过去他收不到。`);
        return false;
      }
    }
    const realType = (typeVal === 'assign' || typeVal === 'special')
      ? (assigneeNo === S.me.no ? 'special' : 'assign') : typeVal;
    const observers = realType === 'special' ? obsPicked.slice() : [];
    S.tasks.push({
      id: uid('t'), type: realType, title,
      ownerNo: S.me.no, publisherNo: S.me.no, assigneeNo,
      dueDate: e,
      assignee: assigneeNo === S.me.no ? '我' : nameOf(assigneeNo),
      start: s, end: e, time: $('#f_time').value || '',
      std: $('#f_std').value.trim(), status: 'todo',
      cat1: catInputVal('#modal', 'cat1'), cat2: catInputVal('#modal', 'cat2'),
      imp: Number($('#f_imp').value) || null, urg: Number($('#f_urg').value) || null,
      stages, sourceId: null,
      intakeStatus: realType === 'assign' ? 'pending' : null,
      routineId: null, planDate: null, detached: false, observers
    });
    S.intake = buildIntake(); S.stageIntake = buildStageIntake(); S.members = buildMembers();
    save(); render(); closeModal();
    if (realType === 'assign') toast(`已发布给 ${nameOf(assigneeNo)}，等他在承接台接收`);
    else if (typeVal === 'assign') toast('承接人是你自己，已放入你的专项工作');
    else toast(observers.length ? `已创建：${title}（知情人 ${observers.length} 人）` : '已创建：' + title);
  }, t === 'assign' ? '发布' : '创建');
  if (t !== 'temp') $('#modal').classList.add('wide');
  renumberStageRows();
  obsPicked = [];
  renderObserverList('');
  /* 知情人列表是在 openModal 之后才填进去的，里面有一堆复选框。
     「填过没有」的快照要在填完之后重拍一次，否则一打开就被判定成「已经改过」，
     空表单点遮罩也关不掉——防误关不能变成关不掉。 */
  modalSnap = modalSnapshot();
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
        ${catInputsHTML(rule ? rule.cat1 : null, rule ? rule.cat2 : null, 'r')}
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
      cat1: catInputVal('#modal', 'cat1'), cat2: catInputVal('#modal', 'cat2'),
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

/* 接收：一步所有权转移——这条活从此归我，进我的专项工作。
   这里刻意不派发、不通知：接过来先自己理一遍，理完再点「派发」才把活交出去。 */
async function acceptTask(id) {
  try {
    const r = await api('/api/task/accept', { method: 'POST', body: JSON.stringify({ me: S.me.no, id }) });
    if (!r.ok) { toast(r.msg || '接收没成功'); return; }
    await refresh(true); render();
    toast('已接收，进「专项工作」里了。理完计划再点「派发」');
  } catch (e) { toast('接收失败：' + e.message); }
}
/* 加入待办：把分给我的一段收进自己的待办，落成一条临时任务（幂等） */
async function joinStage(taskId, stageId) {
  try {
    const r = await api('/api/stage/join', { method: 'POST', body: JSON.stringify({ me: S.me.no, id: taskId, stageId }) });
    if (!r.ok) { toast(r.msg || '加入没成功'); return; }
    await refresh(true); render();
    toast(r.existed ? '这一段已经在你的待办里了' : '已加入待办，进「今日待办」了');
  } catch (e) { toast('加入失败：' + e.message); }
}
/* 派发：把已指定的责任人一次性交出去。派发之前，对方那边什么都没有。 */
async function dispatchTask(id) {
  try {
    const r = await api('/api/task/dispatch', { method: 'POST', body: JSON.stringify({ me: S.me.no, id }) });
    if (!r.ok) { toast(r.msg || '派发没成功'); return; }
    await refresh(true); render();
    toast(r.n ? `已派发 ${r.n} 段，责任人会在承接台看到` : (r.msg || '没有待派发的子任务'));
  } catch (e) { toast('派发失败：' + e.message); }
}
/* 变更提醒「知道了」：按任务一次清掉 */
async function markSeen(taskId) {
  const ids = (S.notices || []).filter(n => n.taskId === taskId).map(n => n.id);
  try { await api('/api/notice/seen', { method: 'POST', body: JSON.stringify({ me: S.me.no, ids }) }); } catch (e) { }
  await refresh(true); render();
}

/* ============ 交互动作 ============ */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1900);
}

/* 拖动的业务含义：只改「这一段的计划日期」，不改归属、不改规则、不动历史。
   校验顺序：是否是我的 → 是否已完成 → 目标是否在过去 → 阶段/常规的特殊约束 → 相邻阶段顺序。
   返回 { ok, why }，why 会直接展示给使用者，所以必须说人话。 */
function dragCheck(t, date, si) {
  if (!t) return { ok: false, why: '找不到这条任务' };
  if (t.ownerNo !== S.me.no && t.assigneeNo !== S.me.no) {
    return { ok: false, why: '这不是你的任务，改期请找发布人' };
  }
  const stage = si >= 0 ? (t.stages || [])[si] : null;
  if (stage && stage.done) {
    return { ok: false, why: `「${stage.name || '这个节点'}」已完成，已经发生的日期不能再挪` };
  }
  if (t.status === 'done') {
    return { ok: false, why: '已完成的任务不能改期；要改请先改回进行中' };
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, why: '没落到具体日期上' };
  if (date < TODAY) {
    return { ok: false, why: '不能拖到过去：改计划改不了已经发生的事' };
  }
  if (stage) {
    if (t.type === 'routine') {
      if (!isWorkday(date)) {
        return { ok: false, why: '常规工作只在工作日发生，这一次不能挪到周末或节假日；要改请编辑规则' };
      }
      return { ok: true };
    }
    /* 专项/发布任务的阶段是区间：整体平移，保持阶段长短，且不能压到前后阶段 */
    const span = stage.end ? diffDays(stage.end, stage.start || stage.end) : 0;
    const newEnd = addDays(date, span);
    /* 相邻关系按同层算：子任务只和同父的兄弟比，顶层阶段只和顶层比。
       按数组下标直接取上一条会把「上一阶段的最后一个子任务」当成相邻段，误报重叠。 */
    const sib = siblingsOf(t.stages, si);
    const pos = sib.findIndex(o => o.i === si);
    const prev = pos > 0 ? sib[pos - 1].x : null;
    const next = pos >= 0 && pos < sib.length - 1 ? sib[pos + 1].x : null;
    const scope = stage.pid ? '同一个阶段下的' : '';
    if (prev) {
      const pe = prev.end || prev.date || prev.start;
      if (pe && date <= pe) {
        return { ok: false, why: `会和${scope}「${prev.name || ''}」（到 ${fmt(pe)}）重叠；要按顺序，不能倒着排` };
      }
    }
    if (next) {
      const ns = next.start || next.date || next.end;
      if (ns && newEnd >= ns) {
        return { ok: false, why: `会压到${scope}「${next.name || ''}」（${fmt(ns)} 开始）；先把下一段往后挪，或把这一段缩短` };
      }
    }
    /* 子任务不能拖出父阶段的窗口。阶段的起止是人设的，拖子任务不会让它变长——
       要更多时间就把那一段延长，那是个看得见的动作，而不是拖完发现阶段悄悄变了。 */
    if (stage.pid) {
      const p = t.stages.find(x => x.id === stage.pid);
      if (p) {
        const ps = p.start || p.date, pe = p.end || p.date || ps;
        const no = topNo(t.stages, p);
        if (ps && date < ps) {
          return { ok: false, why: `「${p.name || '这一段'}」从 ${fmt(ps)} 开始，子任务不能排到它前面；先把第 ${no} 段提前` };
        }
        if (pe && newEnd > pe) {
          return { ok: false, why: `这样「${stage.name || '这个子任务'}」要到 ${fmt(newEnd)}，可第 ${no} 段「${p.name || ''}」只到 ${fmt(pe)}；先把这一段延长到 ${fmt(newEnd)}，或者缩短这条子任务` };
        }
      }
    }
    /* 周末不单独拦：阶段是区间，跨周末是常态（一段 11-06 → 11-10 中间必然包含周末）。
       真正要拦的是「同层重叠」和「超出父阶段窗口」，上面已经判过了。 */
    /* 拖过了发布时定的总截止：服务端最后会拒，但那时候人已经看到日期变了，白折腾一次。
       只锁「别人发布给我」的活——自己建的专项，截止跟着计划走，不该拦自己。 */
    const due = t.dueDate || '';
    const dueLocked = !!(t.publisherNo && t.publisherNo !== t.ownerNo);
    if (due && dueLocked && newEnd > due) {
      return { ok: false, why: `拖到这儿最晚是 ${fmt(newEnd)}，超过发布时定的截止 ${fmt(due)}；要往后排，先让发布人改总截止` };
    }
    return { ok: true };
  }
  /* 整条任务平移：同样不能把结束日推到总截止之后 */
  if (t.type !== 'routine') {
    const span = (t.start && t.end) ? diffDays(t.end, t.start) : 0;
    const ne = addDays(date, span);
    const due = t.dueDate || '';
    const dueLocked = !!(t.publisherNo && t.publisherNo !== t.ownerNo);
    if (due && dueLocked && ne > due) {
      return { ok: false, why: `整条挪过去最晚是 ${fmt(ne)}，超过发布时定的截止 ${fmt(due)}；要往后排，先让发布人改总截止` };
    }
  }
  if (t.type === 'routine' && !isWorkday(date)) {
    return { ok: false, why: '常规工作只在工作日发生；要改到周末请编辑规则' };
  }
  return { ok: true };
}

function moveTask(id, date, si) {
  const t = S.tasks.find(x => x.id === id);
  if (!t) return;
  const verdict = dragCheck(t, date, si);
  if (!verdict.ok) { toast('没有改：' + verdict.why); render(); return; }
  if (si != null && si >= 0 && (t.stages || [])[si]) {
    const s = t.stages[si];
    if (t.type === 'routine') {
      if (s.date === date) return;
      s.date = date;
      /* 常规实例可能挂着多个节点（如月度薪酬工作），起止要跟着全部节点走，不能压成当天 */
      const ds = t.stages.map(x => x.date).filter(Boolean).sort();
      if (ds.length) { t.start = ds[0]; t.end = ds[ds.length - 1]; }
      else { t.start = date; t.end = date; }
      save(); render();
      toast(`「${s.name || t.title}」这一次挪到 ${fmt(date)}，规则本身不变`);
      return;
    }
    const span = s.end ? diffDays(s.end, s.start || s.end) : 0;
    if (s.start === date) return;
    const delta = diffDays(date, s.start || s.end);
    s.start = date; s.end = addDays(date, span);
    const kids = s.id ? t.stages.filter(k => k.pid === s.id) : [];
    if (kids.length) {
      /* 拖的是阶段：整段平移，子任务跟着走同样的天数，相对关系不变。
         窗口是人定的，所以整段挪就是整段挪，里面的子任务不会丢掉原有的排布。 */
      kids.forEach(k => {
        if (k.start) k.start = addDays(k.start, delta);
        if (k.end) k.end = addDays(k.end, delta);
        if (k.date) k.date = addDays(k.date, delta);
      });
    }
    /* 拖的是子任务：父阶段的窗口不动，越界在上面 dragCheck 里已经拦了 */
    const tops = t.stages.filter(x => !x.pid);
    const ds = tops.map(x => x.start || x.date).filter(Boolean).sort();
    const de = tops.map(x => x.end || x.date).filter(Boolean).sort();
    if (ds.length) { t.start = ds[0]; t.end = de[de.length - 1]; }
    save(); render();
    const tail = t.ownerNo !== S.me.no ? `；${nameOf(t.ownerNo)} 会看到这次改期` : '';
    toast(`「${s.name || t.title}」挪到 ${fmt(date)}${span ? ' → ' + fmt(addDays(date, span)) : ''}${kids.length ? `，${kids.length} 个子任务一起移动` : ''}${tail}`);
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
    const tail = t.ownerNo !== S.me.no ? `；${nameOf(t.ownerNo)} 会看到这次改期` : '';
    toast(`已改期：${fmt(t.start)}${t.start !== t.end ? ' → ' + fmt(t.end) : ''}${tail}`);
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
      <p class="desc">填写工号与密码。首次登录的初始密码就是你的工号，登录后请到「设置」里改掉。</p>
      <div class="auth-field"><label>工号</label><input id="a_no" placeholder="你的工号"/></div>
      <div class="auth-field"><label>密码</label><input id="a_pwd" type="password" placeholder="初始密码为工号"/></div>
      <div class="auth-err" id="a_err">${msg || ''}</div>
      <div class="actions"><button class="btn primary" data-act="do-login">进入工作台</button></div>
      <div class="auth-hint">初始密码 = 本人工号（首次登录后请及时修改）。<br/>
        管理账号 admin 改密前的随机密码在服务启动日志里；忘了就重启一次服务，会打印新的（旧的立即作废）。<br/>
        一期仅站内使用：不做邮件、不做企业微信、不做手机推送。</div>`;
    return;
  }
  if (authStep === 'admin-pwd') {
    body.innerHTML = `
      <div class="step">首次登录</div>
      <h3>先改掉一次性初始密码</h3>
      <p class="desc">初始管理密码是一次性随机密码，长期留在日志里不安全。换成只有你知道的密码后才会进入管理面板。</p>
      <div class="auth-field"><label>新密码（至少 8 位）</label><input id="a_new" type="password" autocomplete="new-password"/></div>
      <div class="auth-field"><label>再输一次</label><input id="a_new2" type="password" autocomplete="new-password"/></div>
      <div class="auth-err" id="a_err">${msg || ''}</div>
      <div class="actions"><button class="btn primary" data-act="admin-pwd-save">保存并进入</button></div>
      <div class="auth-hint">当前账号：admin（不占工号、不出现在花名册里）</div>`;
    return;
  }
  body.innerHTML = `
    <div class="step">STEP 2 / 2 · 汇报关系</div>
    <h3>选择你的直属上级</h3>
    <p class="desc">一个账号只有一个直属上级，决定你出现在谁的「下属」名单里、谁能看到你的常规工作和专项进展。可搜索工号或姓名。</p>
    <div class="auth-field" style="margin-bottom:9px"><input id="a_kw" placeholder="搜索工号 / 姓名" value="${esc(authKw)}"/></div>
    <div class="mgr-list" id="mgrList">${mgrListHTML(authKw)}</div>
    <div class="auth-err" id="a_err">${msg || ''}</div>
    <div class="actions">
      <button class="btn ghost" data-act="skip-mgr">暂时跳过</button>
      <button class="btn primary" data-act="confirm-mgr">确定</button>
    </div>
    <div class="auth-hint">暂不设置也能用：发布任务、任务承接台、今日待办、常规、专项、临时任务、日历都正常。
      只是你不设上级，别人就看不到你的常规工作和专项进展。
      ${S && S.me ? `<br/><span style="color:#7b8a9d">当前身份：${esc(S.me.name)} · ${esc(S.me.no)}</span>
      <span class="btn link" data-act="close-auth" style="margin-left:6px">返回工作台</span>` : ''}</div>`;
}
async function doLogin() {
  const no = ($('#a_no').value || '').trim();
  const pwd = ($('#a_pwd').value || '');
  if (!no || !pwd) return authRender('工号和密码都要填');
  try {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ no, password: pwd }) });
    if (!r.ok) return authRender(r.msg || '登录失败');
    /* 首次登录的 admin：cookie 已经发了，但服务端在改密前只放行改密/退出 */
    if (r.mustChange) {
      authOldPwd = pwd;
      authStep = 'admin-pwd';
      return authRender();
    }
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
  /* 身份在 cookie 里，前端不再传 me——传了也只是给服务端校验用 */
  const st = await api('/api/state');
  adopt(st);
  setSync('ok', '已同步');
}

/* ============ 事件 ============ */
document.addEventListener('click', e => {
  const nav = e.target.closest('.nav-item');
  if (nav) { view = nav.dataset.view; render(); return; }
  /* 账号菜单：点到菜单外面就收起（菜单内的菜单项自己负责关） */
  if (!e.target.closest('#acct')) closeAcctMenu();
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
      finishAuth('已跳过。不设上级照样能发布任务，只是你不会出现在别人的「下属」名单里。可随时在设置里补。');
      break;
    case 'switch-user':
    case 'open-mgr':
      if (S && S.me) { authStep = 'mgr'; authPick = S.me.mgr ? Object.assign({}, S.me.mgr) : null; authKw = ''; authRender(); }
      break;
    case 'close-auth': $('#auth').classList.remove('show'); break;
    case 'logout':
      if (confirm('退出登录？（数据在服务端，不会丢）')) {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        /* 先让服务端删会话再刷新：只清本地的话刷新回来还是登录态，等于没退 */
        api('/api/logout', { method: 'POST', body: '{}' })
          .catch(() => { })
          .finally(() => { localStorage.removeItem(ME_KEY); location.reload(); });
      }
      break;
    case 'export-tasks':
      /* 走 fetch 再触发下载：要拿到状态码才能区分「会话过期」和「导出成功」 */
      exportTasks();
      break;
    case 'acct-toggle': {
      const menu = $('#acctMenu');
      const btn = document.querySelector('[data-act="acct-toggle"]');
      if (!menu) break;
      menu.hidden = !menu.hidden;
      if (btn) btn.setAttribute('aria-expanded', String(!menu.hidden));
      break;
    }
    case 'go-pwd':
      goPassword();
      break;
    case 'change-pwd': {
      const oldPwd = ($('#pwd_old') || {}).value || '';
      const newPwd = ($('#pwd_new') || {}).value || '';
      if (!oldPwd || !newPwd) { toast('原密码和新密码都要填'); break; }
      api('/api/password', { method: 'POST', body: JSON.stringify({ me: S.me.no, old: oldPwd, new: newPwd }) })
        .then(r => {
          if (!r.ok) { toast(r.msg || '改密失败'); return; }
          $('#pwd_old').value = ''; $('#pwd_new').value = '';
          toast('密码已更新，其它设备上的登录已失效');
        })
        .catch(err => toast('改密失败：' + err.message));
      break;
    }
    case 'admin-pwd-save': {
      const a = ($('#a_new') || {}).value || '';
      const b = ($('#a_new2') || {}).value || '';
      if (a.length < 8) { authRender('管理密码至少 8 位'); break; }
      if (a !== b) { authRender('两次输入不一致'); break; }
      api('/api/password', { method: 'POST', body: JSON.stringify({ old: authOldPwd, new: a }) })
        .then(async r => {
          if (!r.ok) { authRender(r.msg || '修改失败'); return; }
          authOldPwd = '';
          await loadState();
          finishAuth('管理密码已更新');
        })
        .catch(e => authRender('连不上服务：' + e.message));
      break;
    }
    case 'admin-sess': loadAdminPanels(); break;
    case 'admin-pw': {
      api('/api/admin/initial-passwords')
        .then(r => {
          const box = $('#adminPwdList');
          if (!box) return;
          if (!r.ok) { box.innerHTML = `<div class="note">${esc(r.msg || '读不到名单')}</div>`; return; }
          if (!r.list.length) { box.innerHTML = '<div class="note">没有人在用初始密码了。</div>'; return; }
          box.innerHTML = r.list.map(x => `<div class="kv"><span>${esc(x.name)} · ${esc(x.no)}</span>
            <b>首次登录 ${esc((x.firstLoginAt || '').slice(0, 19).replace('T', ' '))} · ${esc(x.firstLoginIp || '')}
            <span class="btn link" data-act="admin-reset" data-no="${esc(x.no)}">重置为工号</span></b></div>`).join('');
        })
        .catch(err => toast('读取失败：' + err.message));
      break;
    }
    case 'admin-reset': {
      const tno = el.dataset.no;
      if (!confirm(`把 ${tno} 的密码重置回工号？他的所有登录会被踢下线。`)) break;
      api('/api/admin/reset-password', { method: 'POST', body: JSON.stringify({ me: S.me.no, no: tno }) })
        .then(r => { toast(r.msg || (r.ok ? '已重置' : '重置失败')); if (r.ok) { el.closest('.kv').remove(); } })
        .catch(err => toast('重置失败：' + err.message));
      break;
    }
    case 'memrow': openMembers[id] = !openMembers[id]; render(); break;
    case 'fold-special': openSpecialBlock = !openSpecialBlock; render(); break;
    case 'watch-task': {
      /* 关注下属的一条专项：和关注常规同一套机制，只是挂的是任务而不是规则 */
      const subNo = el.dataset.m, taskId = el.dataset.t;
      const i = (S.watch || []).findIndex(w => w.kind === 'special' && w.subNo === subNo && w.taskId === taskId);
      if (i >= 0) S.watch.splice(i, 1);
      else S.watch.push({ id: 'w_' + S.me.no + '_' + subNo + '_t_' + taskId, subNo, ruleId: null, kind: 'special', taskId });
      save(); render();
      toast(i >= 0 ? '已取消关注' : '已关注，会出现在「我关注的任务」里');
      break;
    }
    case 'obs-del': {
      const t = S.tasks.find(x => x.id === id);
      const no = el.dataset.no;
      if (t) {
        t.observers = (t.observers || []).filter(x => x !== no);
        save(); render();
        toast(`已移除知情人：${nameOf(no)}`);
      }
      break;
    }
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
    case 'open': openTaskPage(id); break;
    /* 日历上的卡片：定位到右侧当天清单，让人就地改状态；详情在那一行点 */
    case 'cal-focus': {
      const si = el.dataset.si == null || el.dataset.si === '' ? -1 : Number(el.dataset.si);
      focusKey = `${el.dataset.id}|${si >= 0 ? si : ''}`;
      const chipCell = el.closest('.cell[data-date]');
      /* 右边「今日待办」那摞卡片不在格子里，它本来就是今天的活 */
      selDay = chipCell ? chipCell.dataset.date : TODAY;
      render();
      scrollToFocus();
      break;
    }
    case 'close': closeTaskPage(); break;
    case 'toggle':
      if (t) {
        t.status = t.status === 'done' ? 'todo' : 'done';
        S.members = buildMembers();
        save(); render(); toast(t.status === 'done' ? '已标记完成' : '已恢复为待开展');
      }
      break;
    case 'new': openNewTask(el.dataset.type || 'temp'); break;
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
        save(); closeTaskPage(); render(); toast('已删除');
      }
      break;
    case 'stage-add': {
      if (!t) break;
      const name = $('#sName').value.trim();
      if (!name) { toast('先填阶段名称'); break; }
      const s = $('#sStart').value || t.start, e2 = $('#sEnd').value || s;
      /* 新段先拼在末尾交给校验，通过后由校验按开始日重排到它该在的位置；
         所以这里不要求它比最后一段更晚——只要和已有各段不重叠就行。 */
      const next = (t.stages || []).map(x => Object.assign({}, x));
      const node = { id: uid('s'), pid: null, name, start: s, end: e2, done: false };
      next.push(node);
      const v = validateStages(t, next, { action: 'add-stage', newName: name, newPid: '', newNode: node });
      if (!v.ok) { toast(v.msg); break; }
      t.stages = next;
      /* 任务周期是一级阶段的包络，加完段要跟着更新：不然卡片和总截止还按旧区间算 */
      restatTaskSpan(t);
      save(); openTaskPage(t.id); render(); toast('阶段已添加');
      break;
    }
    case 'stage-sub': {
      if (!t) break;
      const i = Number(el.dataset.idx), p = t.stages[i];
      if (!p) break;
      if (p.pid) { toast('子任务下面不能再拆了'); break; }
      const row = el.closest('.stage');
      if (row.nextElementSibling && row.nextElementSibling.classList.contains('subadd')) break;
      /* 编号按一级阶段的实际位置算，和左边那段圆标对得上 */
      const no = (t.stages || []).filter(x => !x.pid).indexOf(p) + 1;
      /* 默认日期以前直接抄父阶段的整段，等于保证「第二条子任务一定和第一条重叠」。
         现在改成在父阶段窗口里找空档；窗口满了就明说装不下、让人先延长这一段。
         注意：加子任务**不会**把阶段撑长——阶段时间是人设的，得由人来改。 */
      const kids = kidsOf(t.stages, p.id);
      const slot = freeSlot(p, kids, 1);
      const slotTip = slot.overflow
        ? `这一段的 ${dateSpan(p)} 被 ${kids.length} 个子任务占满了，默认排在 <b>${fmt(slot.start)}</b>，已经在窗口外——这样加会被拦。要加进来，先把这一段的结束日延长到 ${fmt(slot.end)}。`
        : `默认放进这段的空档里；这一段的窗口是 ${dateSpan(p)}，下面已有 ${kids.length} 个子任务。`;
      row.insertAdjacentHTML('afterend', `<div class="subadd">
        <div class="subadd-h">在第 <b>${no}</b> 段「${esc(p.name)}」下面加一个子任务</div>
        <input class="sname" placeholder="这段具体做什么，例如：取数并核对口径" style="width:100%;border:1px solid var(--line);border-radius:7px;padding:6px 8px;font-size:12.5px;font-family:inherit"/>
        <div class="row">
          <input type="date" class="sst" value="${slot.start}"/>
          <input type="date" class="sen" value="${slot.end}"/>
          <span class="lbl2">谁做</span>
          <select class="swho" title="这段由谁做；不选就是承接人自己做">
            <option value="">承接人自己做</option>
            ${(S.roster || []).filter(x => x.activated).map(x => `<option value="${x.no}">${esc(x.name)}</option>`).join('')}
          </select>
          <button class="btn primary sm" data-act="stage-add-sub" data-id="${t.id}" data-idx="${i}">加</button>
          <button class="btn ghost sm" data-act="subadd-cancel">取消</button>
        </div>
        <div class="mini" style="margin-top:6px;line-height:1.5">${slotTip}<br/>选上别人之后，点上面的「派发」，他才会在承接台收到。</div>
      </div>`);
      break;
    }
    case 'subadd-cancel':
      if (el.closest('.subadd')) el.closest('.subadd').remove();
      break;
    /* 改阶段：原来只能删了重建，改个错别字或挪两天都得重来一遍，等于变相惩罚修改。
       就地展开一个小表单，名称和起止一起改；有子任务的阶段时间由子任务决定，只让改名。 */
    case 'stage-edit': {
      if (!t) break;
      const i = Number(el.dataset.idx), s = (t.stages || [])[i];
      if (!s) break;
      document.querySelectorAll('#view .sedit').forEach(x => x.remove());
      const row = el.closest('.stage');
      const kids = kidsOf(t.stages, s.id);
      const from = s.start || s.date || t.start;
      const to = s.end || s.date || from;
      /* 编号和左边那圈数字对得上，用户才知道自己在改哪一行 */
      const tops = (t.stages || []).filter(x => !x.pid);
      const lbl = s.pid
        ? `${tops.findIndex(x => x.id === s.pid) + 1}.${(t.stages || []).filter(x => x.pid === s.pid).indexOf(s) + 1}`
        : String(tops.indexOf(s) + 1);
      row.insertAdjacentHTML('afterend', `<div class="sedit" data-idx="${i}">
        <div class="sedit-h">改第 <b>${lbl}</b> ${s.pid ? '个子任务' : '段'}「${esc(s.name || '')}」</div>
        <input class="sname" value="${esc(s.name || '')}" placeholder="${s.pid ? '子任务名称' : '阶段名称'}"/>
        ${s.pid ? `<label class="sedit-who">谁做
          <select class="swho" data-sedit-who="${i}">${stageWhoOptions(t, s.who || '')}</select></label>` : ''}
        <div class="row">
          <input type="date" class="sst" value="${from}"/>
          <input type="date" class="sen" value="${to}"/>
          <button class="btn primary sm" data-act="stage-save" data-id="${t.id}" data-idx="${i}">保存</button>
          <button class="btn ghost sm" data-act="sedit-cancel">取消</button>
        </div>
        <div class="mini" style="margin-top:6px">${kids.length
          ? `这一段的窗口是 ${dateSpan(s)}，下面 ${kids.length} 个子任务要排在里面；缩短时不能把它们挤到窗口外。`
          : '结束日期不能早于开始日期，也不能压到前后两段上'}</div>
      </div>`);
      break;
    }
    case 'sedit-cancel':
      if (el.closest('.sedit')) el.closest('.sedit').remove();
      break;
    /* 阶段延长不需要单独入口：编辑框里的结束日直接改就行。
       以前这里有个「拉长到」，是因为有子任务的阶段被锁了日期框、只能绕道去拉子任务——
       那个前提本身就是错的（阶段时间不该由子任务决定），入口一并去掉。 */
    case 'stage-save': {
      if (!t) break;
      const i = Number(el.dataset.idx), s = (t.stages || [])[i];
      const box = el.closest('.sedit');
      if (!s || !box) break;
      const name = box.querySelector('.sname').value.trim();
      if (!name) { toast('阶段名称不能为空'); break; }
      /* 一律在副本上改，校验通过了才写回。以前是先改内存再发请求，
         服务端拒了只弹一句「保存失败」——人已经看到界面变了，白高兴一场。 */
      const next = t.stages.map(x => Object.assign({}, x));
      const cur = next[i];
      cur.name = name;
      /* 日期就是表单里填的。有子任务时也照改——装不下会被校验拦下来并说清是哪个子任务出界，
         而不是像以前那样锁住输入框、让人以为阶段时间不能碰。 */
      const ns = box.querySelector('.sst').value;
      let ne = box.querySelector('.sen').value;
      if (!ns) { toast('先选开始日期'); break; }
      if (!ne) ne = ns;
      cur.start = ns;
      cur.end = ne;
      /* 单日节点改成区间时把 date 摘掉，否则日历还按单日取 */
      if (cur.date) { if (ne === ns) cur.date = ns; else delete cur.date; }
      const v = validateStages(t, next, { action: 'stage-save' });
      if (!v.ok) { toast(v.msg); break; }
      t.stages = next;
      const tops = t.stages.filter(x => !x.pid);
      const ds = tops.map(x => x.start || x.date).filter(Boolean).sort();
      const de = tops.map(x => x.end || x.date).filter(Boolean).sort();
      if (ds.length) { t.start = ds[0]; t.end = de[de.length - 1]; }
      /* 表单里也能换人：走同一个 setStageWho，别在这儿再写一遍清洗逻辑。
         注意校验会按开始日重排同层，原来的下标 i 可能已经指向别的段，这里按对象找回新位置。 */
      const whoBox = box.querySelector('[data-sedit-who]');
      if (whoBox) setStageWho(t, t.stages.indexOf(cur), whoBox.value || null, whoBox, true);
      save(); openTaskPage(t.id); render(); toast(`已更新「${name}」`);
      break;
    }
    case 'stage-add-sub': {
      if (!t) break;
      const box = el.closest('.subadd');
      const name = box.querySelector('.sname').value.trim();
      if (!name) { toast('先填子任务名称'); break; }
      const i = Number(el.dataset.idx), p = t.stages[i];
      if (!p || p.pid) { toast('这一级不能再拆了'); break; }
      const whoEl = box.querySelector('.swho');
      const who = whoEl ? (whoEl.value || null) : null;
      /* 选了具体的人先记下 who，但不写 whoAt：要等这一页上的「派发」按下去，
         对方那边才看得到。和新建任务时的口径完全一致。 */
      if (who && !empActivated(who)) {
        toast(`${nameOf(who)} 还没有登录过工作台，子任务派过去他收不到。`);
        break;
      }
      /* 这条入口以前一句校验都没有，日期默认又是父阶段整段——两条同名同期的子任务
         就是从这儿进来的。现在先在副本上拼好、过统一校验，通过了才落库。 */
      const next = t.stages.map(x => Object.assign({}, x));
      if (!next[i].id) next[i].id = uid('s');   /* 老数据里的阶段没有 id，第一次挂子任务时补上 */
      const s = box.querySelector('.sst').value || p.start || t.start;
      const e2 = box.querySelector('.sen').value || s;
      const node = { id: uid('s'), pid: next[i].id, name, start: s, end: e2, done: false, who };
      next.push(node);
      /* 父阶段的窗口原样保留，只校验新节点是否落在里面 */
      const v = validateStages(t, next, { action: 'add-sub', newName: name, newPid: next[i].id, newNode: node });
      if (!v.ok) { toast(v.msg); break; }
      t.stages = next;
      save(); openTaskPage(t.id); render();
      toast(who ? `子任务已加，${nameOf(who)} 这一段还等你点「派发」` : '子任务已添加');
      break;
    }
    case 'stage-toggle': {
      if (!t) break;
      const i = Number(el.dataset.idx);
      const s = t.stages[i];
      if (!s) break;
      if (hasKids(t.stages, s)) { toast('这个阶段下面有子任务，勾子任务就行'); break; }
      /* 不是自己的任务（我只是一段的责任人）：本地改完 save() 也发不上去，
         因为 /api/sync 只收 owner 是我的行。走专用接口，两边同一个真相。 */
      if (t.ownerNo !== S.me.no) {
        (async () => {
          try {
            const r = await api('/api/stage/toggle', { method: 'POST', body: JSON.stringify({ me: S.me.no, id: t.id, stageId: s.id, done: !s.done }) });
            if (!r.ok) { toast(r.msg || '没勾上'); return; }
            await refresh(true); openTaskPage(t.id); render();
          } catch (e) { toast('没勾上：' + e.message); }
        })();
        break;
      }
      s.done = !s.done;
      if (allLeavesDone(t)) t.status = 'done';
      else if (t.status === 'done') t.status = 'doing';
      S.members = buildMembers();
      save(); openTaskPage(t.id); render();
      break;
    }
    case 'task-dispatch': dispatchTask(id); break;
    case 'stage-join': joinStage(id, el.dataset.sid); break;
    case 'notice-seen': markSeen(el.dataset.tid); break;
    case 'due-set': {
      if (!t) break;
      const d = prompt('这条任务的总截止（YYYY-MM-DD）', t.dueDate || t.end);
      if (!d) break;
      (async () => {
        try {
          const r = await api('/api/task/due', { method: 'POST', body: JSON.stringify({ me: S.me.no, id: t.id, date: d }) });
          if (!r.ok) { toast(r.msg || '改不了'); return; }
          await refresh(true); openTaskPage(t.id); render();
          toast('总截止已改为 ' + fmt(d));
        } catch (e) { toast('改不了：' + e.message); }
      })();
      break;
    }
    case 'intake-accept': acceptTask(id); break;
    case 'stage-del': {      if (!t) break;
      const s = t.stages[Number(el.dataset.idx)];
      if (!s) break;
      const kids = s.id ? t.stages.filter(x => x.pid === s.id) : [];
      if (kids.length && !confirm(`「${s.name}」下面还有 ${kids.length} 个子任务，一起删掉？`)) break;
      t.stages = t.stages.filter(x => x !== s && !(s.id && x.pid === s.id));
      /* 删子任务不动父阶段的窗口：窗口是人设的，不会因为里面少了一条就自己缩短 */
      /* 删掉最后一段之后总区间要收回来，不然卡片上还挂着已经不存在的那一段的结束日 */
      const tops = t.stages.filter(x => !x.pid);
      const ds = tops.map(x => x.start || x.date).filter(Boolean).sort();
      const de = tops.map(x => x.end || x.date).filter(Boolean).sort();
      if (ds.length) { t.start = ds[0]; t.end = de[de.length - 1]; }
      save(); openTaskPage(t.id); render();
      break;
    }
    case 'stage-restore': {
      if (!t || !t.planDate) break;
      t.start = t.planDate; t.end = t.planDate;
      save(); openTaskPage(t.id); render(); toast('已恢复为规则日期');
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
      renumberStageRows();
      break;
    }
    case 'mstage-sub': {
      const row = el.closest('.mrow');
      const pid = row.dataset.tmp;
      const st = row.querySelector('.sst').value || TODAY;
      const en = row.querySelector('.sen').value || st;
      /* 插到该阶段最后一个子行之后，不然第二、第三个子会倒着排 */
      let anchor = row;
      while (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('sub')
        && anchor.nextElementSibling.dataset.pid === pid) anchor = anchor.nextElementSibling;
      anchor.insertAdjacentHTML('afterend', stageRowHTML(st, en, pid));
      renumberStageRows();
      break;
    }
    case 'mstage-del': {
      const row = el.closest('.mrow');
      const pid = row.dataset.tmp;
      /* 删父行时把它下面的子行一起删掉，不留孤儿 */
      if (pid) {
        let next = row.nextElementSibling;
        while (next && next.classList.contains('sub') && next.dataset.pid === pid) {
          const n2 = next.nextElementSibling;
          next.remove();
          next = n2;
        }
      }
      row.remove();
      renumberStageRows();
      break;
    }
    case 'toggle-step': {
      if (!t || !(t.stages || []).length) break;
      const i = Number(el.dataset.idx), s2 = t.stages[i];
      if (!s2) break;
      if (hasKids(t.stages, s2)) { toast('这个阶段下面有子任务，勾子任务就行'); break; }
      s2.done = !s2.done;
      t.status = allLeavesDone(t) ? 'done' : 'doing';
      S.members = buildMembers();
      save();
      if (detailId === t.id) openTaskPage(t.id);
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

/* 日历拖拽：拖动过程中就把能不能放说清楚，别等松手才弹失败 */
let dragCtx = null, dragBlocked = '';
const DRAG_TIP = '拖动 = 改期 · 单击 = 在右侧清单里定位';
function setDragHint(text, warn) {
  const el = $('#dragHint');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('warn', !!warn);
}
function clearDragUI() {
  $$('.cell.drop-hot').forEach(c => c.classList.remove('drop-hot'));
  $$('.cell.drop-no').forEach(c => c.classList.remove('drop-no'));
  setDragHint(DRAG_TIP, false);
  dragCtx = null; dragBlocked = '';
}
document.addEventListener('dragstart', e => {
  const el = e.target.closest('[data-drag]');
  if (!el) return;
  dragCtx = null; dragBlocked = '';
  try {
    const o = JSON.parse(el.dataset.drag);
    dragCtx = { t: S.tasks.find(x => x.id === o.id) || null, si: o.s == null ? -1 : o.s };
  } catch (err) { }
  e.dataTransfer.setData('text/plain', el.dataset.drag);
  e.dataTransfer.effectAllowed = 'move';
  el.classList.add('dragging');
});
document.addEventListener('dragend', e => {
  const el = e.target.closest('[data-drag]');
  if (el) el.classList.remove('dragging');
  /* 拖到不能放的地方松手时，浏览器不会触发 drop，原因得在这里补一句，别让提示一闪就没 */
  if (dragBlocked) toast('没有改：' + dragBlocked);
  clearDragUI();
});
document.addEventListener('dragover', e => {
  const cell = e.target.closest('.cell[data-date]');
  if (!cell) return;
  const verdict = dragCtx && dragCtx.t ? dragCheck(dragCtx.t, cell.dataset.date, dragCtx.si) : { ok: true };
  if (!verdict.ok) {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    dragBlocked = verdict.why;
    cell.classList.add('drop-no');
    setDragHint('放不下：' + verdict.why, true);
    return;
  }
  e.preventDefault();
  dragBlocked = '';
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  cell.classList.remove('drop-no');
  cell.classList.add('drop-hot');
  setDragHint(`松手改到 ${fmt(cell.dataset.date)}`, false);
});
document.addEventListener('dragleave', e => {
  const cell = e.target.closest('.cell[data-date]');
  if (cell) cell.classList.remove('drop-hot', 'drop-no');
});
document.addEventListener('drop', e => {
  const cell = e.target.closest('.cell[data-date]');
  if (!cell) return;
  e.preventDefault();
  cell.classList.remove('drop-hot', 'drop-no');
  const raw = e.dataTransfer.getData('text/plain');
  if (!raw) return;
  let id = raw, si = -1;
  try { const o = JSON.parse(raw); id = o.id; si = (o.s == null ? -1 : o.s); } catch (err) { }
  moveTask(id, cell.dataset.date, si);
  clearDragUI();
});

/* 日历点选日期：点空地只换右边的日子；点卡片有它自己的动作（cal-focus 定位那一条） */
document.addEventListener('click', e => {
  const cell = e.target.closest('.cell[data-date]');
  if (cell && !e.target.closest('[data-drag]') && !e.target.closest('[data-act]')) { selDay = cell.dataset.date; focusKey = ''; render(); }
});

/* 抽屉内字段编辑 */
document.addEventListener('change', e => {
  /* 知情人多选：勾上就加进名单，取消就去掉；改完重画列表，把「已选 N 人」同步上 */
  if (e.target.closest('#f_obs_list') && e.target.matches('input[type=checkbox]')) {
    const no = e.target.dataset.no;
    if (e.target.checked) { if (!obsPicked.includes(no)) obsPicked.push(no); }
    else obsPicked = obsPicked.filter(x => x !== no);
    const kw = $('#f_obs_kw');
    renderObserverList(kw ? kw.value : '');
    return;
  }
  if (e.target.matches('[data-act="qstatus"]')) {
    const t = S.tasks.find(x => x.id === e.target.dataset.id);
    if (!t) return;
    t.status = e.target.value;
    /* 状态和节点必须对得上，否则日历上会出现「状态已完成、节点还没做」这种自相矛盾的画面：
       设完成 = 节点全勾；常规实例退回待开展 = 节点全放（它是重复事项，不做进度考古）；
       选进行中/暂缓时至少留一个未完成节点。 */
    if ((t.stages || []).length) {
      if (t.status === 'done') leavesOf(t.stages).forEach(s2 => { s2.done = true; });
      else if (t.status === 'todo' && t.type === 'routine') t.stages.forEach(s2 => { s2.done = false; });
      else {
        const lv = leavesOf(t.stages);
        if (lv.length && lv.every(s2 => s2.done)) lv[lv.length - 1].done = false;
      }
    }
    if (t.type === 'assign' && t.assigneeNo === S.me.no && t.status !== 'todo') t.intakeStatus = 'accepted';
    S.members = buildMembers(); S.intake = buildIntake();
    save(); render();
    toast(`「${t.title}」已改为${ST[t.status].name}`);
    return;
  }
  const modal = e.target.closest('#modal');
  if (modal && e.target.id === 'r_cycle') {
    ruleStepsDraft = readStepRows(); renderStepWrap(e.target.value);
    const pw = $('#r_policy_wrap'), dn = $('#r_day_note');
    if (pw) pw.style.display = e.target.value === 'day' ? 'none' : '';
    if (dn) dn.style.display = e.target.value === 'day' ? 'block' : 'none';
    return;
  }
  /* 弹窗里换了承接人：子任务那几行「承接人自己做（谁）」要跟着变，
     否则人已经换成李四了，下拉还在说「王磊自己做」 */
  if (modal && e.target.id === 'f_assignee') {
    const own = e.target.value || S.me.no;
    document.querySelectorAll('#stageRows .mrow.sub .swho').forEach(s => {
      const o = s.querySelector('option[value=""]');
      if (o) o.textContent = `承接人自己做（${nameOf(own)}）`;
    });
    return;
  }
  /* 只剩承接台那个弹窗有 #f_type 了：新建任务的类型由入口钉死，弹窗里不给换。
     这里保留是因为承接时要由本人决定「这件活在我这儿算什么」，换了还得跟着换承接人。 */
  if (modal && e.target.matches('#f_type')) {
    const prev = e.target.dataset.prev || 'special';
    const next = e.target.value;
    e.target.dataset.prev = next;
    // 类型一换，承接人就跟着换：只有发布任务能选人，其余锁回本人
    const wrap = $('#fAssigneeWrap');
    if (wrap) wrap.innerHTML = assigneeFieldInner(next, null);
    /* 知情人只在专项任务上有意义：类型切走就把这块收起来 */
    const obs = $('#fObsWrap');
    if (obs) obs.style.display = next === 'special' ? '' : 'none';
    if (next === 'temp') toast('临时任务默认归入「其他 / 临时事项」');
    return;
  }
  const dr = e.target.closest('#view');
  if (!dr || !detailId) return;
  const t = S.tasks.find(x => x.id === detailId);
  if (!t) return;
  /* 「谁做」下拉：select 的新值只在 change 里拿得到。挂到 click 上的话，
     点开下拉那一刻读到的还是旧值，选完什么都不发生——看上去就是「改不了」。 */
  if (e.target.matches('[data-act="stage-who"]')) {
    setStageWho(t, Number(e.target.dataset.idx), e.target.value || null, e.target);
    return;
  }
  /* 加知情人：只加不改，名单本身随任务一起存 */
  if (e.target.matches('[data-act="obs-add"]')) {
    const no = e.target.value;
    if (no) {
      t.observers = (t.observers || []).includes(no) ? (t.observers || []) : (t.observers || []).concat([no]);
      save(); render();
      toast(`已把 ${nameOf(no)} 设为知情人`);
    }
    return;
  }
  const f = e.target.dataset.field;
  if (!f) return;
  if (f === 'cat1' || f === 'cat2') {
    t[f] = e.target.value.trim() || null;
    save(); render(); return;
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
    const no = e.target.value;
    /* 新建、承接弹窗都拦了未登录的人，详情页换人这里漏了——
       只能等服务端回 errors，而下拉会停在那个"收不到活"的人名上。三处口径要一致。 */
    if (no !== S.me.no && !empActivated(no)) {
      toast(`${nameOf(no)} 还没有登录过工作台，派过去收不到——先让他登录一次，或改派给别的同事`);
      e.target.value = t.assigneeNo;
      return;
    }
    t.assigneeNo = no;
    t.assignee = t.assigneeNo === S.me.no ? '我' : nameOf(t.assigneeNo);
    if (t.type === 'assign' && t.assigneeNo !== S.me.no && t.ownerNo === S.me.no) t.intakeStatus = 'pending';
  } else {
    t[f] = e.target.value;
  }
  S.members = buildMembers(); S.intake = buildIntake();
  /* 只重渲染，不调 openTaskPage：后者会把页面滚回顶部，改个分类/日期就跳走很烦 */
  save(); render();
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

$('#modalWrap').addEventListener('click', e => { if (e.target.id === 'modalWrap') tryCloseModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAcctMenu(); if ($('#modalWrap').classList.contains('show')) tryCloseModal(); else closeTaskPage(); }
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
  if (e.target.id === 'f_obs_kw') renderObserverList(e.target.value);
});

/* ============ 启动 ============ */
(async function init() {
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
    /* 401 已经由 onAuthLost 切到登录页；这里只负责别把真正的网络错误说成「会话失效」 */
    if (e.status === 401) return;
    authStep = 'login';
    authRender('连不上服务（' + e.message + '），请稍后重试');
  }
})();
