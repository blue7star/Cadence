'use strict';
/**
 * 初级管理者工作台 · MVP 服务端
 * 零依赖：Node 内置 http + node:sqlite（Node >= 22）
 * 数据落在 data/workbench.db，多人共用同一个进程，改动即时可见。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { SEMVER, getChangelog, getChangelogHistory, getFullVersion } = require('./version');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'workbench.db');
const PORT = Number(process.env.PORT || 8788);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ============ 日期工具 ============ */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [a, b, c] = String(s).split('-').map(Number); return new Date(a, b - 1, c); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const dow = s => parse(s).getDay();
const monthStart = s => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth(), 1)); };
const monthEnd = s => { const d = parse(s); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };
const todayStr = () => iso(new Date());
const nowStr = () => new Date().toISOString();

/* ============ 数据库 ============ */
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = OFF');

db.exec(`
CREATE TABLE IF NOT EXISTS emp(
  no TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, dept TEXT,
  mgr_no TEXT, active INTEGER DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS cat(
  id TEXT PRIMARY KEY, owner_no TEXT NOT NULL, lvl INTEGER DEFAULT 1,
  parent_id TEXT, name TEXT NOT NULL, sort INTEGER DEFAULT 0, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS rule(
  id TEXT PRIMARY KEY, owner_no TEXT NOT NULL, title TEXT NOT NULL,
  cycle TEXT DEFAULT 'month', policy TEXT DEFAULT 'prev',
  cat1 TEXT, cat2 TEXT, steps TEXT DEFAULT '[]', active INTEGER DEFAULT 1, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS task(
  id TEXT PRIMARY KEY, owner_no TEXT NOT NULL, assignee_no TEXT, type TEXT, title TEXT,
  std TEXT, start_date TEXT, end_date TEXT, time TEXT, status TEXT DEFAULT 'todo',
  cat1 TEXT, cat2 TEXT, imp INTEGER, urg INTEGER, stages TEXT DEFAULT '[]',
  routine_id TEXT, plan_date TEXT, source_id TEXT, detached INTEGER DEFAULT 0,
  intake_status TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS watch(
  id TEXT PRIMARY KEY, mgr_no TEXT, sub_no TEXT, rule_id TEXT
);
CREATE TABLE IF NOT EXISTS holiday(
  date TEXT PRIMARY KEY, kind TEXT, name TEXT
);
CREATE TABLE IF NOT EXISTS op_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_no TEXT, action TEXT, detail TEXT, ip TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_task_owner ON task(owner_no);
CREATE INDEX IF NOT EXISTS idx_task_assignee ON task(assignee_no);
CREATE INDEX IF NOT EXISTS idx_task_routine ON task(routine_id);
CREATE INDEX IF NOT EXISTS idx_rule_owner ON rule(owner_no);
`);

/* ============ 迁移：老库直接可用，不重建 ============ */
/* SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，只能先查列在不在。
   所有新增列都给默认值，老行的含义不变——这是 data/workbench.db 不重建的前提。 */
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
/* emp.activated：这个人有没有登录过工作台过。
   没有它就没法判断「派下去他收不收得到」——只能事后等人来问。 */
ensureColumn('emp', 'activated', 'INTEGER DEFAULT 0');
ensureColumn('emp', 'last_login', 'TEXT');
/* watch.kind：'routine' = 关注下属的一条常规；'special' = 关注下属的一条专项。 */
ensureColumn('watch', 'kind', "TEXT DEFAULT 'routine'");
ensureColumn('watch', 'task_id', 'TEXT');

/* 知情人用独立关联表，不在 task 里塞 JSON 列：
   要问的是「我知道情了哪些专项」，按人反查，JSON 列查不动。 */
db.exec(`
CREATE TABLE IF NOT EXISTS task_observer(
  task_id TEXT NOT NULL, emp_no TEXT NOT NULL, created_at TEXT,
  PRIMARY KEY(task_id, emp_no)
);
CREATE INDEX IF NOT EXISTS idx_obs_emp ON task_observer(emp_no);
`);

/* 0.7.0：一条任务有「发布人」和「承接人」两个角色。
   publisher_no 永远是发起人；owner_no 会随「接收」转移给承接人。
   分成两个字段才做得到「发布人始终能看到进度，但接出去之后不能改」。 */
ensureColumn('task', 'publisher_no', 'TEXT');
/* 发布人定的总截止。承接人的计划结束日不得超过它。 */
ensureColumn('task', 'due_date', 'TEXT');
/* 子任务责任人「加入待办」生成的临时任务，用这列指回父任务的某一段 */
ensureColumn('task', 'stage_ref', 'TEXT');

/* 派发之后的每一次计划变更都要让责任人看见——没有推送，就靠承接台里的这张表。
   removed 是墓碑：节点被删了，责任人得知道自己那条预约没了，不能凭空消失。 */
db.exec(`
CREATE TABLE IF NOT EXISTS stage_notice(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL, stage_id TEXT, emp_no TEXT NOT NULL,
  kind TEXT NOT NULL, summary TEXT, at TEXT, seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notice_emp ON stage_notice(emp_no);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_task_publisher ON task(publisher_no)');

/* 老数据回填：登录过的人（op_log 里有 login 记录）置为已激活。
   不回填的话，升级当天所有老同事都会被当成「从没登录过」，下派会被全部拦死。

   只做一次。以前这条每次启动都跑，结果是：测试里把某人改回「未激活」，一重启又被
   op_log 的历史记录顶回「已激活」——夹具永远复位不了，真实库里还会留下测试造的登录态。
   迁移只该发生一次，之后 activated 归业务写。 */
if (!db.prepare("SELECT v FROM meta WHERE k='activated_backfill'").get()) {
  db.exec(`UPDATE emp SET activated=1
    WHERE activated=0 AND no IN (SELECT DISTINCT actor_no FROM op_log WHERE action='login')`);
  db.prepare("INSERT INTO meta(k,v) VALUES('activated_backfill','1')").run();
}

/* 0.7.0 迁移：老库直接能用，但不能失忆。
   ③ 这条最关键：老数据里「已接收」的任务还挂在发布人名下，
   新模型里接收=所有权转移，不补这一步，承接人会突然变成只读。 */
if (!db.prepare("SELECT v FROM meta WHERE k='publisher_backfill'").get()) {
  db.exec(`UPDATE task SET publisher_no = COALESCE(
      (SELECT s.owner_no FROM task s WHERE s.id = task.source_id), owner_no)
    WHERE publisher_no IS NULL`);
  db.exec('UPDATE task SET due_date = end_date WHERE due_date IS NULL');
  const moved = db.prepare(`UPDATE task SET owner_no = assignee_no
    WHERE intake_status='accepted' AND assignee_no IS NOT NULL AND assignee_no <> owner_no
      AND NOT EXISTS (SELECT 1 FROM task c WHERE c.source_id = task.id)`).run().changes;
  db.prepare("INSERT INTO meta(k,v) VALUES('publisher_backfill','1')").run();
  if (moved) console.log(`[migrate] ${moved} 条老「已接收」任务完成所有权转移`);
}

/* ============ 初始化：花名册与节假日 ============ */
const SEED_EMP = [
  ['1012', '王磊', '产品组组长', '产品部', '1001'],
  ['1001', '张启明', '部门经理', '产品部', null],
  ['1002', '李明', '产品经理', '产品部', '1012'],
  ['1003', '陈静', '数据分析', '产品部', '1012'],
  ['1004', '王浩', '研发工程师', '产品部', '1012'],
  ['1005', '赵敏', '运营', '产品部', '1012'],
  ['1101', '吴敏', '人力资源总监', '人力资源部', null],
  ['1102', '陈国栋', '运营总监', '运营中心', null]
];
const HOL_CFG = [
  ['元旦', '2026-01-01', '2026-01-03'],
  ['春节', '2026-02-15', '2026-02-21'],
  ['清明', '2026-04-04', '2026-04-06'],
  ['劳动节', '2026-05-01', '2026-05-05'],
  ['端午', '2026-06-19', '2026-06-21'],
  ['中秋', '2026-09-25', '2026-09-27'],
  ['国庆', '2026-10-01', '2026-10-07'],
  ['元旦', '2027-01-01', '2027-01-03']
];
const MAKEUP = ['2026-02-14', '2026-02-28', '2026-04-26', '2026-05-09', '2026-09-28', '2026-10-10'];

(function seedBase() {
  const empCount = db.prepare('SELECT COUNT(*) c FROM emp').get().c;
  if (!empCount) {
    const ins = db.prepare('INSERT INTO emp(no,name,role,dept,mgr_no,active,created_at) VALUES(?,?,?,?,?,1,?)');
    for (const [no, name, role, dept, mgr] of SEED_EMP) ins.run(no, name, role, dept, mgr, nowStr());
  }
  const holCount = db.prepare('SELECT COUNT(*) c FROM holiday').get().c;
  if (!holCount) {
    const ins = db.prepare('INSERT OR IGNORE INTO holiday(date,kind,name) VALUES(?,?,?)');
    for (const [name, from, to] of HOL_CFG) {
      let d = from, guard = 0;
      while (d <= to && guard < 60) { ins.run(d, 'holiday', name); d = addDays(d, 1); guard++; }
    }
    for (const d of MAKEUP) ins.run(d, 'makeup', '补班');
  }
  const rev = db.prepare('SELECT v FROM meta WHERE k=?').get('rev');
  if (!rev) db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run('rev', '1');
})();

/* ============ 工作日 / 节假日 ============ */
const HOL_MAP = (() => {
  const m = {};
  for (const r of db.prepare('SELECT date,kind,name FROM holiday').all()) m[r.date] = r;
  return m;
})();
const isHoliday = s => HOL_MAP[s] && HOL_MAP[s].kind === 'holiday';
const isMakeup = s => HOL_MAP[s] && HOL_MAP[s].kind === 'makeup';
const isWorkday = s => isMakeup(s) ? true : (isHoliday(s) ? false : (dow(s) !== 0 && dow(s) !== 6));
function shiftDay(s, policy) {
  if (policy === 'none') return s;
  if (isWorkday(s)) return s;
  let d = s, i = 0;
  const step = policy === 'next' ? 1 : -1;
  while (!isWorkday(d) && i < 15) { d = addDays(d, step); i++; }
  return d;
}

/* ============ 常规工作：规则 → 周期实例 ============ */
function ruleSteps(rule) {
  const steps = JSON.parse(rule.steps || '[]');
  return steps.length ? steps : [{ name: '', day: rule.day, weekday: rule.weekday, time: rule.time }];
}
function cyclesBetween(rule, a, b) {
  const out = [];
  if (rule.cycle === 'day') {
    let d = a, guard = 0;
    while (d <= b && guard < 500) { out.push({ key: d, from: d, to: d, anchor: d }); d = addDays(d, 1); guard++; }
    return out;
  }
  if (rule.cycle === 'week') {
    let mon = addDays(a, -((dow(a) + 6) % 7)), guard = 0;
    while (mon <= b && guard < 200) {
      out.push({ key: mon, from: mon, to: addDays(mon, 6), anchor: mon });
      mon = addDays(mon, 7); guard++;
    }
    return out;
  }
  let m = monthStart(a), guard = 0;
  while (m <= b && guard < 60) {
    out.push({ key: m.slice(0, 7), from: m, to: monthEnd(m), anchor: m });
    const d = parse(m);
    m = iso(new Date(d.getFullYear(), d.getMonth() + 1, 1)); guard++;
  }
  return out;
}
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

const insTaskStmt = db.prepare(`INSERT OR IGNORE INTO task
  (id,owner_no,assignee_no,type,title,std,start_date,end_date,time,status,cat1,cat2,imp,urg,stages,
   routine_id,plan_date,source_id,detached,intake_status,publisher_no,due_date,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

function ensureInstances(rule, from, to) {
  const steps = ruleSteps(rule);
  const now = nowStr();
  for (const c of cyclesBetween(rule, from, to)) {
    const id = 'ri_' + rule.id + '_' + c.key;
    if (db.prepare('SELECT 1 x FROM task WHERE id=?').get(id)) continue;
    const built = [];
    for (const s of steps) {
      const plan = stepPlanDate(rule, s, c);
      const pol = s.policy || rule.policy || 'prev';
      /* 日常规 = 每个工作日：周末与法定假日一律不生成（顺延会把几条堆到同一天） */
      if (rule.cycle === 'day' && !isWorkday(plan)) continue;
      if (!isWorkday(plan) && pol === 'none') continue;
      const actual = rule.cycle === 'day' ? plan : shiftDay(plan, pol);
      built.push({ name: s.name || '', plan, date: actual, time: s.time || '', done: false, mo: Number(s.mo || 0) });
    }
    if (!built.length) continue;
    built.sort((x, y) => (x.plan < y.plan ? -1 : 1));
    const dates = built.map(x => x.date).sort();
    insTaskStmt.run(
      id, rule.owner_no, rule.owner_no, 'routine', rule.title, '',
      dates[0], dates[dates.length - 1],
      built.length === 1 ? built[0].time : '', 'todo',
      rule.cat1, rule.cat2, null, null,
      JSON.stringify(built.length > 1 ? built : []),
      rule.id, built[0].plan, null, 0, null,
      rule.owner_no, dates[dates.length - 1], now, now
    );
  }
}

/** 生成窗口：往前 40 天、往后 80 天，够日历前后翻页用 */
function routineWindow() {
  const t = todayStr();
  return { from: monthStart(addDays(t, -40)), to: addDays(t, 80) };
}

function maintain(ownerNos) {
  const w = routineWindow();
  for (const no of ownerNos) {
    const rules = db.prepare('SELECT * FROM rule WHERE owner_no=? AND active=1').all(no);
    for (const r of rules) ensureInstances(r, w.from, w.to);
  }
}

function regenRule(rule) {
  if (!rule.active) return;   /* 停用期间不重排、不补生成：已有安排原样保留 */
  const t = todayStr();
  const monthKey = t.slice(0, 7);
  const rows = db.prepare('SELECT * FROM task WHERE routine_id=?').all(rule.id);
  const doneNames = new Set();
  for (const r of rows) {
    if (r.status === 'done') continue;
    for (const s of JSON.parse(r.stages || '[]')) if (s.done) doneNames.add(s.name || '');
  }
  /* 本月及以后、未完成的一律重排（周期边界可能变了，旧排期不再成立） */
  db.prepare(`DELETE FROM task WHERE routine_id=? AND status<>'done'
              AND substr(coalesce(plan_date,start_date),1,7) >= ?`).run(rule.id, monthKey);
  const w = routineWindow();
  ensureInstances(rule, w.from, w.to);
  if (doneNames.size) {
    const left = db.prepare('SELECT * FROM task WHERE routine_id=?').all(rule.id);
    const upd = db.prepare('UPDATE task SET stages=?,status=?,updated_at=? WHERE id=?');
    for (const r of left) {
      const steps = JSON.parse(r.stages || '[]');
      if (!steps.length) continue;
      let touched = false;
      for (const s of steps) {
        if (!s.done && s.date <= t && doneNames.has(s.name || '')) { s.done = true; touched = true; }
      }
      if (!touched) continue;
      upd.run(JSON.stringify(steps), steps.every(x => x.done) ? 'done' : 'doing', nowStr(), r.id);
    }
  }
}

/** 清理「规则已删除但实例还在」的残留；打了 detached 的保留 */
function pruneOrphans(ownerNos) {
  for (const no of ownerNos) {
    const rules = db.prepare('SELECT id FROM rule WHERE owner_no=?').all(no).map(r => r.id);
    const insts = db.prepare(`SELECT id,routine_id FROM task WHERE owner_no=? AND type='routine' AND detached=0`).all(no);
    const del = db.prepare('DELETE FROM task WHERE id=?');
    for (const i of insts) if (!rules.includes(i.routine_id)) del.run(i.id);
  }
  /* 0.6.1 之前删任务不清知情人名单，老库里可能留着指向已删任务的孤儿行。
     必须放在上面删完实例之后：本函数自己也会删任务，放开头就变成「扫掉上一轮的孤儿」，
     这一次新产生的要等下一次 GET 才清。 */
  db.prepare('DELETE FROM task_observer WHERE task_id NOT IN (SELECT id FROM task)').run();
  /* 提醒是短期通知，不是台账：30 天前的清掉，别让表一直涨。 */
  db.prepare('DELETE FROM stage_notice WHERE at < ?').run(new Date(Date.now() - 30 * 864e5).toISOString());
}

/* ============ 身份与可见范围 ============ */
function getEmp(no) { return db.prepare('SELECT * FROM emp WHERE no=? AND active=1').get(String(no || '')); }
function subsOf(no) { return db.prepare('SELECT no,name,role,dept FROM emp WHERE mgr_no=? AND active=1 AND no<>?').all(no, no); }

/* 子任务责任人：三级节点（pid 非空）才有 who。
   who 为空表示「跟随承接人」——换承接人时这些子任务自动跟着走，不会挂在旧人头上。 */
const parseStages = raw => { try { return JSON.parse(raw || '[]'); } catch (e) { return []; } };
/* 派生临时任务反指父任务的那一段：{taskId, stageId}。老数据可能没有，返回 null。 */
const parseRef = raw => {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return null; }
};
const stageOwnerOf = (t, s) => s.who || t.assignee_no || t.owner_no;
/* 我是否负责这条任务里的某一段：必须已派发（whoAt 有值）。
   只指定、没派发，对执行者来说等于没这回事——这条判定全站共用一个。 */
function stageWhoMe(r, meNo) {
  return parseStages(r.stages).some(s => s && s.pid && s.who === meNo && s.whoAt);
}

function stateFor(meNo) {
  const me = getEmp(meNo);
  if (!me) return null;
  const subs = subsOf(meNo);
  const ownerNos = [meNo, ...subs.map(s => s.no)];
  pruneOrphans(ownerNos);
  maintain(ownerNos);

  const names = {};
  for (const e of db.prepare('SELECT no,name,role,dept,mgr_no FROM emp').all()) names[e.no] = e.name;
  const mgr = me.mgr_no ? db.prepare('SELECT no,name,role,dept FROM emp WHERE no=?').get(me.mgr_no) : null;

  /* 我派出去、对方已「规划并承接」的原任务 id。承接方新建的任务带着 source_id 指回来，
     不给上级看就等于派完就断线：主管只知道「已接收」，之后进度、是否延期一概不知。
     0.7.0 起接收改为「所有权转移」，这条只剩兼容 0.5/0.6 的老派生数据。 */
  const delegatedSrc = new Set(
    db.prepare("SELECT id FROM task WHERE owner_no=? AND intake_status='accepted'").all(meNo).map(r => r.id)
  );

  const placeholders = ownerNos.map(() => '?').join(',');
  /* 可见集现在有五个来源：我名下的、派给我的、我发布的、下属的常规与专项、我负责某一段。
     子任务责任人挂在 stages JSON 里，SQL 过滤不到——只能整表取回再在 JS 里筛。
     个人工作台量级（千条以内）这样最省事，不值得为它引一层索引。 */
  const rows = db.prepare('SELECT * FROM task').all()
    .filter(r => {
      if (r.owner_no === meNo || r.assignee_no === meNo || r.publisher_no === meNo) return true;
      /* 常规：下属的实例要看（看板要用）；
         专项：下属的专项也要看，否则「下属专项工作推进情况」永远是空的。
         下派/临时：只认自己经手的那条——别人自己的活不因为「他是我下属」就全摊开。 */
      if (ownerNos.includes(r.owner_no) && (r.type === 'routine' || r.type === 'special')) return true;
      if (r.source_id && delegatedSrc.has(r.source_id)) return true;
      return stageWhoMe(r, meNo);
    });

  /* 别人让我知情的专项：我只看进度，不进任何执行链路。
     这一条不扩大别的可见范围——知情人只在「下派任务」页的「我关注的任务」里出现。
     只认 type='special'：契约把知情人的适用范围写死在专项上，不因为库里多了几行就自动放开。 */
  const obsMine = new Set(
    db.prepare(`SELECT o.task_id FROM task_observer o JOIN task t ON t.id=o.task_id
                WHERE o.emp_no=? AND t.type='special'`).all(meNo).map(r => r.task_id)
  );
  const obsRows = obsMine.size
    ? db.prepare(`SELECT * FROM task WHERE id IN (${[...obsMine].map(() => '?').join(',')})`).all(...obsMine)
    : [];
  const seen = new Set(rows.map(r => r.id));
  const allRows = rows.concat(obsRows.filter(r => !seen.has(r.id)));

  /* 每条可见任务的知情人名单（只给自己可见的任务挂，不泄露别人的名单） */
  const obsMap = {};
  for (const r of db.prepare('SELECT task_id, emp_no FROM task_observer').all()) {
    (obsMap[r.task_id] = obsMap[r.task_id] || []).push(r.emp_no);
  }
  const tasks = allRows.map(r => ({
    id: r.id, type: r.type, title: r.title, ownerNo: r.owner_no, assigneeNo: r.assignee_no,
    publisherNo: r.publisher_no || r.owner_no, dueDate: r.due_date || r.end_date,
    stageRef: parseRef(r.stage_ref),
    assignee: r.assignee_no === meNo ? '我' : (names[r.assignee_no] || ''),
    start: r.start_date, end: r.end_date, time: r.time || '', std: r.std || '',
    status: r.status || 'todo', cat1: r.cat1, cat2: r.cat2,
    imp: r.imp == null ? null : Number(r.imp), urg: r.urg == null ? null : Number(r.urg),
    stages: parseStages(r.stages),
    routineId: r.routine_id || null, planDate: r.plan_date || null,
    sourceId: r.source_id || null, detached: !!r.detached,
    intakeStatus: r.intake_status || null, auto: !!r.routine_id,
    /* 名单只给这条任务的经手人看：知情人能看到自己「被告知过」，看不到「还有谁被告知」——
       那是别人的社交关系，不是项目进度。 */
    observers: (r.owner_no === meNo || r.assignee_no === meNo) ? (obsMap[r.id] || []) : [],
    observer: obsMine.has(r.id)
  }));

  const rules = db.prepare('SELECT * FROM rule WHERE owner_no=?').all(meNo).map(r => ({
    id: r.id, title: r.title, cycle: r.cycle, policy: r.policy,
    cat1: r.cat1, cat2: r.cat2, active: !!r.active, steps: JSON.parse(r.steps || '[]')
  }));

  const catRows = db.prepare('SELECT * FROM cat WHERE owner_no=? ORDER BY sort,id').all(meNo);
  const cats = catRows.filter(c => Number(c.lvl) === 1).map(c => ({
    id: c.id, name: c.name,
    children: catRows.filter(k => k.parent_id === c.id).map(k => ({ id: k.id, name: k.name }))
  }));

  const watch = db.prepare('SELECT * FROM watch WHERE mgr_no=?').all(meNo)
    .map(w => ({ id: w.id, subNo: w.sub_no, ruleId: w.rule_id, kind: w.kind || 'routine', taskId: w.task_id || null }));

  /* 可见范围内的常规规则元信息（下属的实例要显示标题与周期） */
  const routines = db.prepare(`SELECT id,owner_no,title,cycle FROM rule WHERE owner_no IN (${placeholders})`)
    .all(...ownerNos)
    .map(r => ({ id: r.id, ownerNo: r.owner_no, title: r.title, cycle: r.cycle }));

  const roster = db.prepare('SELECT no,name,role,dept,mgr_no,activated FROM emp WHERE active=1 ORDER BY no').all()
    .map(e => ({ no: e.no, name: e.name, role: e.role, dept: e.dept, mgrNo: e.mgr_no, activated: !!e.activated }));

  const holidays = db.prepare('SELECT date,kind,name FROM holiday').all();

  /* 未读的变更提醒：派发之后改期/换人/删除都会落到这里，
     承接台靠它告诉责任人「你手上的东西变了」。超过 30 天的在 pruneOrphans 里清。 */
  const notices = db.prepare(`SELECT id,task_id,stage_id,kind,summary,at FROM stage_notice
                              WHERE emp_no=? AND seen_at IS NULL ORDER BY id DESC LIMIT 100`).all(meNo)
    .map(x => ({ id: x.id, taskId: x.task_id, stageId: x.stage_id, kind: x.kind, summary: x.summary, at: x.at }));

  return {
    rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v),
    today: todayStr(),
    me: {
      no: me.no, name: me.name, role: me.role, dept: me.dept,
      mgrNo: me.mgr_no || null,
      mgr: mgr ? { no: mgr.no, name: mgr.name, role: mgr.role, dept: mgr.dept } : null
    },
    subs: subs.map(s => ({ no: s.no, name: s.name, role: s.role, dept: s.dept })),
    roster, cats, rules, tasks, watch, holidays, routines, notices
  };
}

/* ============ 写操作 ============ */
function bumpRev() {
  db.prepare('UPDATE meta SET v = CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k=?').run('rev');
}

/* 阶段树只允许两级嵌套（任务 → 阶段 → 子任务），数组保持扁平，靠 pid 指父。
   三条硬规则，绕过界面直接写接口也一样生效：
   ① 只有 assign / special 允许子任务，temp / routine 一律拉平；
   ② pid 只能指向「pid 为空」的节点，第四级静默拉平成一级（脏数据不该让人卡在保存上）；
   ③ 父阶段的起止不独立存在，有子任务时一律重算为子任务日期的并集。 */
/* 阶段的起止是设定值，不从子任务反推。这里只做「pid 指向的阶段还在不在」的清理：
   父行被删掉时，挂在上面的子任务不能变成孤儿。
   （曾经这里还有一段按子任务并集重算父阶段——前端改了日期，存进来又被改回去，
    人看到的是「点了保存什么都没变」。已删除，别再放回来。） */
function normalizeStages(raw, type) {
  const arr = Array.isArray(raw) ? raw : [];
  if (type !== 'assign' && type !== 'special') return arr.map(s => Object.assign({}, s, { pid: null }));
  const topIds = new Set(arr.filter(s => !s.pid && s.id).map(s => s.id));
  return arr.map(s => {
    const pid = s.pid && topIds.has(s.pid) ? s.pid : null;
    return Object.assign({}, s, { pid });
  });
}

/* 子任务责任人：只在三级节点上生效。
   ① 二级阶段强制清空——「阶段不设责任人」是这套模型的前提，不是界面约束；
   ② who 等于承接人时存 null（跟随承接人），换承接人后自动跟着走；
   ③ 换人必须清 whoAt / joinedAt：新责任人要重新派发、重新点「加入待办」；
   ④ 勾选人（doneBy/doneAt）在完成状态没变时保留，变了就记成这次动手的人。 */
function applyStageOwners(stages, prev, assigneeNo, meNo) {
  const prevById = {};
  for (const s of prev) if (s && s.id) prevById[s.id] = s;
  return stages.map((s, i) => {
    const o = Object.assign({}, s);
    const p = (o.id && prevById[o.id]) || prev[i];
    if (!o.pid) {
      delete o.who; delete o.whoAt; delete o.joinedAt;
    } else if (!o.who || o.who === assigneeNo) {
      o.who = null; o.whoAt = null; o.joinedAt = null;
    } else if (p && p.who === o.who) {
      o.whoAt = p.whoAt || null; o.joinedAt = p.joinedAt || null;
    } else if (!p && o.whoAt) {
      /* 新建节点时自带派发时间：只有示例数据会这么写，界面永远给 null */
      o.joinedAt = o.joinedAt || null;
    } else {
      o.whoAt = null; o.joinedAt = null;
    }
    if (p && !!p.done === !!o.done) { o.doneBy = p.doneBy || null; o.doneAt = p.doneAt || null; }
    else if (o.done) { o.doneBy = meNo; o.doneAt = todayStr(); }
    else { o.doneBy = null; o.doneAt = null; }
    return o;
  });
}

/* 已派给别人的叶子，完成态只归责任人：上级整理自己那条任务时，整段 stages 里
   带回来的旧 done/doneBy/doneAt 一律以库为准。新加的段、换了人的段一律从
   「未完成」开始——客户端不能顺手带一个 done 把别人那段点亮。 */
function keepForeignDone(stages, prev, meNo) {
  const prevById = {};
  for (const s of prev) if (s && s.id) prevById[s.id] = s;
  for (const s of stages) {
    if (!s || !s.pid || !s.who || s.who === meNo) continue;
    const p = s.id ? prevById[s.id] : null;
    if (p && p.who === s.who) {
      s.done = !!p.done;
      s.doneBy = p.doneBy || null;
      s.doneAt = p.doneAt || null;
    } else {
      s.done = false;
      s.doneBy = null;
      s.doneAt = null;
    }
  }
}

/* 换人或移除之后，旧责任人「加入待办」出来的那份副本要收走：
   留着就是一条他永远勾不动、也永远不知道已经失效的待办。
   副本在界面上没有删除入口（只留完成情况），服务端不收就没人能收。 */
function dropStaleMirrors(taskId, prev, stages) {
  const prevById = {};
  for (const s of prev) if (s && s.id) prevById[s.id] = s;
  const nextIds = new Set(stages.filter(s => s && s.id).map(s => s.id));
  const drop = sid => db.prepare('DELETE FROM task WHERE stage_ref LIKE ?')
    .run(`%"taskId":"${taskId}","stageId":"${sid}"%`);
  for (const s of stages) {
    const p = s && s.id ? prevById[s.id] : null;
    if (p && p.who && s.who !== p.who) drop(s.id);
  }
  /* 段被移除：副本反指的那一段已经不存在，留着也勾不动 */
  for (const p of prev) {
    if (p && p.pid && p.id && !nextIds.has(p.id)) drop(p.id);
  }
}

/* 叶子完成态 → 父任务状态。勾选和上行回写共用同一口径，避免两处算出两个结论。
   有子任务时状态跟着叶子走：全部完成才算完成，一段没勾就不许挂「已完成」。
   「暂缓」是执行人自己的节奏，「进行中」同理——只把不该成立的状态掰回来，
   不替人把「已开始但还没勾完」改回「未开始」。 */
function stageStatusFromLeaves(stages, prevStatus) {
  const leaves = stages.filter(x => x && x.pid);
  if (!leaves.length) return prevStatus;
  if (leaves.every(x => x.done)) return 'done';
  if (prevStatus === 'paused') return 'paused';
  if (leaves.some(x => x.done)) return 'doing';
  return prevStatus === 'done' ? 'todo' : (prevStatus || 'todo');
}

/* 完成/撤销完成落到承接台的「有变动的任务」——不弹窗，攒在那一栏里看。
   自己勾自己负责的整条任务时不提醒自己。 */
function notifyStageDone(parent, s, on, byNo) {
  if (parent.owner_no === byNo) return;
  const emp = getEmp(byNo);
  const nm = emp ? emp.name : byNo;
  db.prepare(`INSERT INTO stage_notice(task_id,stage_id,emp_no,kind,summary,at)
              VALUES(?,?,?,?,?,?)`).run(parent.id, s.id, parent.owner_no, 'stage_done',
    on ? `${nm}完成了「${s.name || '子任务'}」` : `${nm}取消了「${s.name || '子任务'}」的完成标记`, nowStr());
}

/* 派生副本完成 → 回写父任务那一段，并把父任务状态推一遍。
   方向只允许「责任人自己那侧 → 上级」：这是唯一的上行通道。 */
function pullStageFromMirror(taskId) {
  const mirror = db.prepare('SELECT * FROM task WHERE id=?').get(taskId);
  if (!mirror || !mirror.stage_ref) return null;
  let ref; try { ref = JSON.parse(mirror.stage_ref); } catch (e) { return null; }
  if (!ref || !ref.taskId || !ref.stageId) return null;
  const parent = db.prepare('SELECT * FROM task WHERE id=?').get(ref.taskId);
  if (!parent) return null;
  const stages = parseStages(parent.stages);
  const s = stages.find(x => x && x.id === ref.stageId && x.pid);
  if (!s) return null;
  /* 副本必须真的属于这一段的责任人，且这一段已经派发：换人之后旧副本不许再写回，
     伪造出来的副本也点不动别人的段。 */
  if (!s.who || s.who !== mirror.owner_no || !s.whoAt) return null;
  const on = mirror.status === 'done';
  if (!!s.done === on) return null;
  s.done = on;
  s.doneBy = on ? mirror.owner_no : null;
  s.doneAt = on ? todayStr() : null;
  const status = stageStatusFromLeaves(stages, parent.status);
  db.prepare('UPDATE task SET stages=?,status=?,updated_at=? WHERE id=?')
    .run(JSON.stringify(stages), status, nowStr(), parent.id);
  notifyStageDone(parent, s, on, mirror.owner_no);
  return parent.id;
}

/* 派发之后的变更要落到责任人的承接台（决策⑨：不设第二次按钮，靠这条通道兜住）。
   只对「已派发」的段写：没派发的段，改了也没人知道过，提醒反而制造噪音。 */
function notifyStageChanges(taskId, prev, next) {
  const prevById = {};
  for (const s of next) if (s && s.id) prevById[s.id] = s;
  const nextById = prevById;
  const ins = db.prepare(`INSERT INTO stage_notice(task_id,stage_id,emp_no,kind,summary,at)
                           VALUES(?,?,?,?,?,?)`);
  const now = nowStr();
  const nm = no => (db.prepare('SELECT name FROM emp WHERE no=?').get(no) || {}).name || no;
  for (const p of prev) {
    if (!p || !p.pid || !p.who || !p.whoAt) continue;
    const n = p.id ? nextById[p.id] : null;
    const label = `「${p.name || '未命名'}」`;
    if (!n) {
      ins.run(taskId, p.id || null, p.who, 'removed', `${label}已从此任务移除`, now);
      continue;
    }
    if (n.who !== p.who) {
      ins.run(taskId, p.id || null, p.who, 'reassigned', `${label}改由 ${nm(n.who)} 负责`, now);
      continue;
    }
    const pd = `${p.start || p.date || ''}→${p.end || p.date || ''}`;
    const nd = `${n.start || n.date || ''}→${n.end || n.date || ''}`;
    if (pd !== nd) ins.run(taskId, p.id || null, p.who, 'moved', `${label}${pd} 改为 ${nd}`, now);
  }
}

function upsertTask(meNo, t, opts) {
  const exist = db.prepare('SELECT * FROM task WHERE id=?').get(t.id);
  const isPubPending = exist && exist.publisher_no === meNo && exist.intake_status === 'pending';

  /* 编辑权只看 owner。发布人在「还没被接收」时可以改（否则发错了收不回来），
     接收之后一律只读——只有总截止 due_date 那一个字段例外，在下面单独判。 */
  if (exist && exist.owner_no !== meNo && !isPubPending) {
    return { ok: false, msg: '这条任务已经交出去了，你只能看进度，改动没有生效' };
  }

  /* 补丁式提交：只带 id+title（或只带 stages）也算数，缺的字段沿用库里的值。
     以前缺字段会一路传到 SQL 绑定上炸掉，人看到的是"Provided value cannot be bound"。
     "没提交"不等于"清空"——这条口径和知情人名单那边一致。 */
  if (exist) {
    const keep = {
      title: 'title', std: 'std', start: 'start_date', end: 'end_date', time: 'time',
      status: 'status', cat1: 'cat1', cat2: 'cat2', imp: 'imp', urg: 'urg', detached: 'detached'
    };
    for (const k in keep) if (t[k] === undefined) t[k] = exist[keep[k]];
    if (t.assigneeNo === undefined) t.assigneeNo = exist.assignee_no;
  }

  const typeRaw = exist ? exist.type : (t.type || 'temp');
  const prevAssignee = exist ? exist.assignee_no : null;
  let assigneeNo = exist ? exist.assignee_no : meNo;
  if (!exist) {
    if ((typeRaw === 'assign' || typeRaw === 'special') && t.assigneeNo && t.assigneeNo !== meNo) assigneeNo = t.assigneeNo;
  } else if (typeRaw === 'assign' && exist.owner_no === meNo && t.assigneeNo) {
    assigneeNo = t.assigneeNo;
  }
  /* 承接口径决定类型：派给别人是下派任务，派给自己是专项（决策①）。
     服务端兜底——界面两边都拦过，接口直写也不能造出「自己派给自己」的下派任务。 */
  const type = (typeRaw === 'assign' || typeRaw === 'special')
    ? (assigneeNo === meNo ? 'special' : 'assign')
    : typeRaw;

  /* 承接人必须是花名册里、并且登录过工作台的人。
     派给一个从没开通过账号的人 = 派了个寂寞：他收不到，活就躺在那里假装有进展。
     只在「新派」或「换人」时拦——老任务的承接人后来离职停用，不该让我连改个标题都改不动。
     示例数据是刻意造出来的场景，不走这道拦（opts.demo）。 */
  if (!opts || !opts.demo) {
    if (type === 'assign' && assigneeNo && assigneeNo !== meNo && assigneeNo !== prevAssignee) {
      const emp = db.prepare('SELECT no,name,activated FROM emp WHERE no=? AND active=1').get(assigneeNo);
      if (!emp) return { ok: false, msg: `花名册里没有工号「${assigneeNo}」，不能派给他` };
      if (!emp.activated) {
        return { ok: false, msg: `${emp.name} 还没有登录过工作台，任务派过去他收不到。先让他登录一次，或者改派给别的同事。` };
      }
    }
  }

  /* 总截止：发布人定的，承接人改不动。老数据回填成当时的结束日，所以不会凭空冒拦截。 */
  const dueStored = exist ? (exist.due_date || exist.end_date) : null;
  const dueChanged = !!(exist && t.dueDate && t.dueDate !== dueStored);
  let dueDate = exist ? dueStored : (t.dueDate || t.end);
  if (dueChanged && (exist.publisher_no || exist.owner_no) === meNo) dueDate = t.dueDate;
  /* 还没交出去的活，截止跟着计划走：发布人就是执行人（或者刚发出去还没人接），
     没有第二个人需要被这个数字约束。不这样处理，自己名下的专项拖一下阶段就被自己的
     截止日拦回来——建的时候 due 就等于当时的 end，一延长必然撞上。
     一旦交出去了（owner 不再是我），这条就收紧：承接人只能在发布人划的框里排。
     明着把总截止改到计划前面是他自己的决定，不拦——留一个负数进度比拦下来有用。 */
  const stillMine = !exist || exist.owner_no === meNo;
  const iAmPublisher = (exist ? (exist.publisher_no || exist.owner_no) : meNo) === meNo;
  if (dueDate && t.end && (type === 'assign' || type === 'special') && t.end > dueDate) {
    if (iAmPublisher && stillMine) {
      if (!dueChanged) dueDate = t.end;
    } else {
      return { ok: false, msg: `计划结束日不能晚于发布时定的截止日 ${dueDate}——要延后请让发布人改总截止` };
    }
  }

  /* 「待接收」现在只由「接收」这个动作解除，不再靠改状态顺带。
     接收 = 所有权转移，和改状态是两件事，混在一起会出现「改了下状态就等于接了」。 */
  let intake = exist ? exist.intake_status : null;
  if (type === 'assign') intake = (exist && assigneeNo === prevAssignee && exist.intake_status) ? exist.intake_status : 'pending';
  else if (!exist || typeRaw === 'assign') intake = null;

  const prevStages = exist ? parseStages(exist.stages) : [];
  /* 没提交 stages 就整段沿用——重新跑一遍 applyStageOwners 会把 whoAt/JOIN 状态洗掉，
     "只改个标题"不该让已派发的子任务退回未派发。 */
  const stages = (exist && t.stages === undefined)
    ? prevStages
    : applyStageOwners(normalizeStages(t.stages, type), prevStages, assigneeNo, meNo);

  /* 子任务责任人同样要拦「没登录过的人」——他只会在承接台收到、不会在站外被通知。 */
  if (!opts || !opts.demo) {
    for (const s of stages) {
      if (!s.pid || !s.who) continue;
      const emp = db.prepare('SELECT no,name,activated FROM emp WHERE no=? AND active=1').get(s.who);
      if (!emp) return { ok: false, msg: `花名册里没有工号「${s.who}」，这个子任务不能派给他` };
      if (!emp.activated) return { ok: false, msg: `${emp.name} 还没有登录过工作台，子任务派过去他收不到。` };
    }
  }
  /* 别人的完成态不许被整段写入带回旧值（上级只改标题也会把 stages 一起提交）。 */
  keepForeignDone(stages, prevStages, meNo);
  /* 新任务不能一出生就带着别人的完成态。 */
  if (!exist && (!opts || !opts.demo)) {
    for (const s of stages) {
      if (!s.pid) continue;
      s.done = false; s.doneBy = null; s.doneAt = null;
    }
  }
  dropStaleMirrors(t.id, prevStages, stages);
  let status = t.status || 'todo';
  if (stages.some(x => x && x.pid)) status = stageStatusFromLeaves(stages, status);

  if (exist) {
    db.prepare(`UPDATE task SET title=?,std=?,start_date=?,end_date=?,time=?,status=?,cat1=?,cat2=?,
                imp=?,urg=?,stages=?,detached=?,assignee_no=?,intake_status=?,type=?,due_date=?,updated_at=? WHERE id=?`)
      .run(t.title, t.std || '', t.start, t.end, t.time || '', status,
        t.cat1 || null, t.cat2 || null,
        t.imp == null || t.imp === '' ? null : Number(t.imp),
        t.urg == null || t.urg === '' ? null : Number(t.urg),
        JSON.stringify(stages), t.detached ? 1 : 0,
        assigneeNo, intake, type, dueDate, nowStr(), t.id);
    if (!opts || !opts.demo) notifyStageChanges(t.id, prevStages, stages);
  } else {
    /* 新建的任务，发起人只能是本人：owner_no 一律落 meNo。
       要派活给谁就发布，不替他建。 */
    if (t.ownerNo && t.ownerNo !== meNo) {
      return { ok: false, msg: '只能建自己的任务——要把活交给别人，用「发布任务」' };
    }
    const now = nowStr();
    db.prepare(`INSERT OR IGNORE INTO task
      (id,owner_no,publisher_no,assignee_no,type,title,std,start_date,end_date,due_date,time,status,cat1,cat2,imp,urg,stages,
       routine_id,plan_date,source_id,stage_ref,detached,intake_status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      t.id, meNo, meNo, assigneeNo, type, t.title, t.std || '',
      t.start, t.end, dueDate, t.time || '', status, t.cat1 || null, t.cat2 || null,
      t.imp == null || t.imp === '' ? null : Number(t.imp),
      t.urg == null || t.urg === '' ? null : Number(t.urg),
      JSON.stringify(stages), t.routineId || null, t.planDate || null,
      /* 派生副本只能由 /api/stage/join 建（服务端写 stage_ref）；客户端提交的
         stageRef 一律丢弃，否则任何人都能伪造一份副本去点亮别人的段。 */
      t.sourceId || null, null,
      t.detached ? 1 : 0, intake, now, now
    );
  }

  /* 责任人自己的派生副本变了，往上汇总到父任务那一段——只走这一个方向。
     上级侧的改动不再往下写副本（那会变成双向循环，谁最后写谁说了算）。 */
  pullStageFromMirror(t.id);

  /* 知情人：只有任务 owner 能定。整体替换——payload 里带了 observers 就以它为准，
     不带就原样保留（/api/sync 是增量合并，"没提交"不等于"清空"）。
     只认 type='special'：契约把知情人锁在专项上，读侧已经这么做了，
     写侧不锁的话，接口可以给下派/临时任务写名单——落库后谁也看不见、也永不清，纯脏数据。 */
  if (Array.isArray(t.observers) && type === 'special') {
    const ownerNo = exist ? exist.owner_no : (t.ownerNo || meNo);
    if (ownerNo === meNo) {
      db.prepare('DELETE FROM task_observer WHERE task_id=?').run(t.id);
      const insObs = db.prepare('INSERT OR IGNORE INTO task_observer(task_id,emp_no,created_at) VALUES(?,?,?)');
      const now = nowStr();
      for (const no of t.observers) {
        if (no && no !== meNo && getEmp(no)) insObs.run(t.id, no, now);
      }
    }
  }
  return { ok: true };
}

function upsertRule(meNo, r) {
  const exist = db.prepare('SELECT * FROM rule WHERE id=?').get(r.id);
  if (exist) {
    if (exist.owner_no !== meNo) return false;
    db.prepare(`UPDATE rule SET title=?,cycle=?,policy=?,cat1=?,cat2=?,steps=?,active=?,updated_at=? WHERE id=?`)
      .run(r.title, r.cycle, r.policy || 'prev', r.cat1 || null, r.cat2 || null,
        JSON.stringify(r.steps || []), r.active === false ? 0 : 1, nowStr(), r.id);
    regenRule(db.prepare('SELECT * FROM rule WHERE id=?').get(r.id));
    return true;
  }
  db.prepare(`INSERT INTO rule(id,owner_no,title,cycle,policy,cat1,cat2,steps,active,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(r.id, meNo, r.title, r.cycle, r.policy || 'prev', r.cat1 || null, r.cat2 || null,
      JSON.stringify(r.steps || []), r.active === false ? 0 : 1, nowStr());
  const w = routineWindow();
  const fresh = db.prepare('SELECT * FROM rule WHERE id=?').get(r.id);
  if (fresh.active) ensureInstances(fresh, w.from, w.to);
  return true;
}

function upsertCat(meNo, c) {
  const exist = db.prepare('SELECT * FROM cat WHERE id=?').get(c.id);
  if (exist) {
    if (exist.owner_no !== meNo) return false;
    db.prepare('UPDATE cat SET name=?,sort=? WHERE id=?').run(c.name, Number(c.sort || 0), c.id);
    return true;
  }
  db.prepare('INSERT INTO cat(id,owner_no,lvl,parent_id,name,sort,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(c.id, meNo, Number(c.level || 1), c.parentId || null, c.name, Number(c.sort || 0), nowStr());
  return true;
}

function applySync(meNo, body) {
  let n = 0;
  const del = body.del || {};
  for (const id of del.tasks || []) {
    const r = db.prepare('SELECT * FROM task WHERE id=?').get(id);
    if (r && r.owner_no === meNo) {
      /* 先给每个已派发的段留一条墓碑：任务一删，责任人的那条预约就凭空消失了，
         不写这一条，他只会觉得"昨天还在的事今天不见了"。 */
      const insN = db.prepare(`INSERT INTO stage_notice(task_id,stage_id,emp_no,kind,summary,at)
                               VALUES(?,?,?,?,?,?)`);
      for (const s of parseStages(r.stages)) {
        if (s && s.pid && s.who && s.whoAt) {
          insN.run(id, s.id || null, s.who, 'removed', `「${r.title}」已被取消，你负责的「${s.name || '子任务'}」不用做了`, nowStr());
        }
      }
      n += db.prepare('DELETE FROM task WHERE id=?').run(id).changes;
      /* 任务没了，知情人名单跟着走——留在库里就成了孤儿，
         下一个人打开「我关注的任务」会看到一条已经删掉的专项。 */
      db.prepare('DELETE FROM task_observer WHERE task_id=?').run(id);
      /* 责任人「加入待办」派生出来的临时任务也要清：父任务没了，它就是一条孤魂。 */
      db.prepare('DELETE FROM task WHERE stage_ref LIKE ?').run(`%"taskId":"${id}"%`);
    }
  }
  for (const id of del.rules || []) {
    const r = db.prepare('SELECT owner_no FROM rule WHERE id=?').get(id);
    if (r && r.owner_no === meNo) n += db.prepare('DELETE FROM rule WHERE id=?').run(id).changes;
  }
  for (const id of del.cats || []) {
    const r = db.prepare('SELECT owner_no FROM cat WHERE id=?').get(id);
    if (r && r.owner_no === meNo) n += db.prepare('DELETE FROM cat WHERE id=?').run(id).changes;
  }
  for (const id of del.watch || []) {
    n += db.prepare('DELETE FROM watch WHERE id=? AND mgr_no=?').run(id, meNo).changes;
  }
  for (const c of body.cats || []) if (upsertCat(meNo, c)) n++;
  for (const r of body.rules || []) if (upsertRule(meNo, r)) n++;
  /* 任务可能被拒（例如下派给一个从没登录过工作台的人）。
     被拒的那条不写库，但要把原因带回去——前端要原话告诉人，不能默默失败。 */
  const errors = [];
  for (const t of body.tasks || []) {
    const r = upsertTask(meNo, t);
    if (r.ok) n++;
    else if (r.msg) errors.push(r.msg);
  }
  for (const w of body.watch || []) {
    if (w.mgrNo && w.mgrNo !== meNo) continue;
    db.prepare('INSERT OR REPLACE INTO watch(id,mgr_no,sub_no,rule_id,kind,task_id) VALUES(?,?,?,?,?,?)')
      .run(w.id, meNo, w.subNo, w.ruleId || null, w.kind || 'routine', w.taskId || null);
    n++;
  }
  if (n) bumpRev();
  return { n, errors };
}

/* ============ 0.7.0 的三个动作 ============
   接收、派发、加入待办都改别人的数据（或改别人看不到的字段），走不了 /api/sync 的
   「谁的行谁提交」，所以各有一个人少的专用接口。四个动作都只做一件事，
   权限判定写在函数第一行——绕过界面直接打接口也拦得住。 */

/** 责任人自己在父任务里勾了那一段时，把他名下的派生副本对齐到同一个结论。
    只在「勾的人就是这一段的责任人」时调用；上级侧不碰副本。 */
function syncMirrorStatus(taskId, stageId, done) {
  const ref = `%"taskId":"${taskId}","stageId":"${stageId}"%`;
  const mir = db.prepare('SELECT id,status FROM task WHERE stage_ref LIKE ?').get(ref);
  if (!mir) return;
  const st = done ? 'done' : 'todo';
  if (mir.status === st) return;
  db.prepare('UPDATE task SET status=?,updated_at=? WHERE id=?').run(st, nowStr(), mir.id);
}

/* 接收：所有权转移。不派发、不通知、不生成副本——这是它和「派发」的分界线。 */
function acceptTask(meNo, id) {
  const r = db.prepare('SELECT * FROM task WHERE id=?').get(id);
  if (!r) return { ok: false, msg: '找不到这条任务' };
  if (r.assignee_no !== meNo) return { ok: false, msg: '这条任务不是派给你的' };
  if (r.intake_status !== 'pending') return { ok: false, msg: '这条任务已经接收过了' };
  db.prepare(`UPDATE task SET owner_no=?, type='special', intake_status='accepted', updated_at=? WHERE id=?`)
    .run(meNo, nowStr(), id);
  bumpRev();
  return { ok: true };
}

/* 派发：把「已指定责任人但还没派」的段一次性交出去。
   派发之前，who 只是一个备注——不产生承接台条目、不产生待办。 */
function dispatchTask(meNo, id) {
  const r = db.prepare('SELECT * FROM task WHERE id=?').get(id);
  if (!r) return { ok: false, msg: '找不到这条任务' };
  if (r.owner_no !== meNo) return { ok: false, msg: '只有承接人能派发这条任务' };
  const stages = parseStages(r.stages);
  const now = nowStr();
  const ins = db.prepare(`INSERT INTO stage_notice(task_id,stage_id,emp_no,kind,summary,at)
                           VALUES(?,?,?,?,?,?)`);
  let n = 0;
  for (const s of stages) {
    if (!s || !s.pid || !s.who || s.whoAt) continue;
    s.whoAt = now;
    n++;
    ins.run(id, s.id || null, s.who, 'dispatched',
      `「${s.name || '子任务'}」分给你：${s.start || s.date || ''}→${s.end || s.date || ''}`, now);
  }
  if (!n) return { ok: true, n: 0, msg: '没有待派发的子任务' };
  db.prepare('UPDATE task SET stages=?,updated_at=? WHERE id=?').run(JSON.stringify(stages), now, id);
  bumpRev();
  return { ok: true, n };
}

/* 加入待办：责任人把某一段收进自己的待办，落地成一条临时任务。
   幂等——同一段只允许一条，重复点只是把已有的那条找回来。 */
function joinStage(meNo, id, stageId) {
  const r = db.prepare('SELECT * FROM task WHERE id=?').get(id);
  if (!r) return { ok: false, msg: '这条任务已经不在你手上了' };
  const stages = parseStages(r.stages);
  const s = stages.find(x => x && x.id === stageId && x.pid);
  if (!s) return { ok: false, msg: '这一段已经从任务里移除了' };
  if (s.who !== meNo) return { ok: false, msg: '这一段不是分给你的' };
  if (!s.whoAt) return { ok: false, msg: '这一段还没派发，等承接人派发后再加入' };

  const ref = `%"taskId":"${id}","stageId":"${stageId}"%`;
  const had = db.prepare('SELECT id FROM task WHERE stage_ref LIKE ?').get(ref);
  if (had) {
    if (!s.joinedAt) {
      s.joinedAt = nowStr();
      db.prepare('UPDATE task SET stages=? WHERE id=?').run(JSON.stringify(stages), id);
    }
    return { ok: true, id: had.id, existed: true };
  }

  const now = nowStr();
  const tid = 'st_' + id + '_' + stageId;
  const start = s.start || s.date || r.start_date;
  const end = s.end || s.date || start;
  db.prepare(`INSERT OR IGNORE INTO task
    (id,owner_no,publisher_no,assignee_no,type,title,start_date,end_date,due_date,status,stages,
     stage_ref,intake_status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tid, meNo, meNo, meNo, 'temp', `${r.title} · ${s.name || '子任务'}`,
    start, end, end, 'todo', '[]', JSON.stringify({ taskId: id, stageId }), null, now, now
  );
  s.joinedAt = now;
  db.prepare('UPDATE task SET stages=?,updated_at=? WHERE id=?').run(JSON.stringify(stages), now, id);
  bumpRev();
  return { ok: true, id: tid, existed: false };
}

/* 勾选：只认这一段的责任人。承接人只维护计划（拆段、派发、改期、换人），
   别人负责的那段他勾不动——完成状态必须由干活的人往上汇总。 */
function toggleStage(meNo, id, stageId, done) {
  const r = db.prepare('SELECT * FROM task WHERE id=?').get(id);
  if (!r) return { ok: false, msg: '这条任务已经不在你手上了' };
  const stages = parseStages(r.stages);
  const s = stages.find(x => x && x.id === stageId && x.pid);
  if (!s) return { ok: false, msg: '这一段已经从任务里移除了' };
  const isOwner = r.owner_no === meNo;
  if (s.who) {
    if (s.who !== meNo) return { ok: false, msg: '这一段由别人负责，只有他能勾完成' };
    if (!s.whoAt) return { ok: false, msg: '这一段还没派发，派发后由你勾完成' };
  } else if (!isOwner) {
    return { ok: false, msg: '这一段不归你勾' };
  }

  const on = done === undefined ? !s.done : !!done;
  /* 父阶段没有独立的勾选态：它的完成由子任务推出来，这里只动叶子。 */
  s.done = on;
  s.doneBy = on ? meNo : null;
  s.doneAt = on ? todayStr() : null;
  /* 状态跟着叶子走，别让「3/3 已完成」还挂在「进行中」上 */
  const status = stageStatusFromLeaves(stages, r.status);
  db.prepare('UPDATE task SET stages=?,status=?,updated_at=? WHERE id=?')
    .run(JSON.stringify(stages), status, nowStr(), id);
  /* 他自己在父任务里勾的，副本那份也对齐；不做反向下写。 */
  if (s.who === meNo) {
    syncMirrorStatus(id, stageId, on);
    notifyStageDone(r, s, on, meNo);
  }
  bumpRev();
  return { ok: true, done: on };
}

/* 总截止只有发布人能改。它不是一个字段的编辑权问题——
   是谁对「什么时候必须交」有话语权。承接人要延期，只能回去找发布人。 */
function setDueDate(meNo, id, date) {
  const r = db.prepare('SELECT * FROM task WHERE id=?').get(id);
  if (!r) return { ok: false, msg: '找不到这条任务' };
  if ((r.publisher_no || r.owner_no) !== meNo) return { ok: false, msg: '只有发布人能改总截止' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, msg: '日期格式不对' };
  if (r.start_date && date < r.start_date) return { ok: false, msg: '总截止不能早于开始日' };
  db.prepare('UPDATE task SET due_date=?,updated_at=? WHERE id=?').run(date, nowStr(), id);
  bumpRev();
  return { ok: true };
}

/* 变更提醒点了「知道了」 */
function markNoticesSeen(meNo, ids) {
  const now = nowStr();
  if (Array.isArray(ids) && ids.length) {
    const st = db.prepare('UPDATE stage_notice SET seen_at=? WHERE id=? AND emp_no=?');
    for (const id of ids) st.run(now, Number(id), meNo);
  } else {
    db.prepare('UPDATE stage_notice SET seen_at=? WHERE emp_no=? AND seen_at IS NULL').run(now, meNo);
  }
  bumpRev();
  return { ok: true };
}

/* ============ 示例数据 ============ */
function seedDemo(meNo) {
  const d = n => addDays(todayStr(), n);
  const has = db.prepare("SELECT COUNT(*) c FROM task WHERE owner_no=? AND type<>'routine'").get(meNo).c;
  if (has > 0) return 0;

  if (!db.prepare('SELECT COUNT(*) c FROM cat WHERE owner_no=?').get(meNo).c) {
    const C = [
      ['c1', '部门管理', [['c11', '例会与汇报'], ['c12', '人员与考勤'], ['c13', '团队建设']]],
      ['c2', '业务交付', [['c21', '需求与评审'], ['c22', '数据与报表'], ['c23', '客户与商机']]],
      ['c3', '其他', [['c31', '临时事项']]]
    ];
    for (const [id, name, kids] of C) {
      upsertCat(meNo, { id: meNo + '_' + id, name, level: 1 });
      for (const [kid, kn] of kids) upsertCat(meNo, { id: meNo + '_' + kid, name: kn, level: 2, parentId: meNo + '_' + id });
    }
  }
  const R = [
    ['r1', '部门晨会', 'day', 'none', [['', null, null, '09:00', 'none']]],
    ['r2', '部门周会', 'week', 'prev', [['', 1, null, '10:00', 'prev']]],
    ['r3', '周报汇总与提交', 'week', 'prev', [['', 5, null, '16:30', 'prev']]],
    ['r4', '月度考勤核对', 'month', 'prev', [['', null, 5, '09:30', 'prev']]],
    ['r5', '月度绩效预评', 'month', 'next', [['', null, 25, '14:00', 'next']]],
    ['r6', '月度薪酬工作', 'month', 'prev', [
      ['核薪邮件发送', null, 28, '10:00', 'prev'],
      ['工资初稿提交', null, 1, '17:00', 'prev', 1],
      ['绩效分析会', null, 10, '14:00', 'next', 1],
      ['工资发放确认', null, 15, '10:00', 'prev', 1]
    ]]
  ];
  for (const [id, title, cycle, policy, steps] of R) {
    upsertRule(meNo, {
      id: meNo + '_' + id, title, cycle, policy,
      cat1: meNo + '_c1', cat2: meNo + '_c1' + (id === 'r6' || id === 'r4' || id === 'r5' ? '2' : '1'),
      active: true,
      steps: steps.map(s => ({ name: s[0], weekday: s[1], day: s[2], mo: s[5] || 0, time: s[3], policy: s[4] }))
    });
  }

  const subs = subsOf(meNo);
  const pick = i => subs.length ? subs[i % subs.length].no : meNo;
  const subA = pick(0), subB = pick(2), subC = pick(3);
  const now = nowStr();
  const st = (id, name, start, end, extra) => Object.assign({ id, name, start, end, done: false }, extra || {});

  /* 示例数据的阶段边界要落在工作日上。按「今天 +N 天」硬算，落到周末就等于有两天
     日历不铺阶段条（周末不显示专项阶段），示例看起来就像排错了。
     逐段往前推，不能各自吸附：各吸各的会吸到同一天，反而造出重叠。
     子任务再收回父阶段窗口，越界的按窗口夹住——示例不能违反自己的校验。 */
  function fitDemoStages(stages) {
    let prevEnd = '';
    for (const s of stages.filter(x => !x.pid)) {
      let a = s.start || s.end, b = s.end || s.start;
      if (prevEnd && a <= prevEnd) a = addDays(prevEnd, 1);
      a = shiftDay(a, 'next');
      b = shiftDay(b < a ? a : b, 'next');
      s.start = a; s.end = b;
      prevEnd = b;
    }
    for (const k of stages.filter(x => x.pid)) {
      const p = stages.find(x => x.id === k.pid);
      if (!p) continue;
      let a = k.start || k.end, b = k.end || k.start;
      if (a < p.start) a = p.start;
      if (a > p.end) a = p.end;
      if (b > p.end) b = p.end;
      if (b < a) b = a;
      k.start = a; k.end = b;
    }
    const tops = stages.filter(x => !x.pid);
    if (tops.length) {
      const ss = tops.map(x => x.start).filter(Boolean).sort();
      const ee = tops.map(x => x.end).filter(Boolean).sort();
      return { stages, start: ss[0], end: ee[ee.length - 1] };
    }
    return { stages, start: '', end: '' };
  }

  /* 演示数据要能一眼看懂这套流程：两条在等接收、一条已经移交出去、
     一条我自己的专项里已经派人（一个已加入待办、一个还没）。 */
  const T = [
    { id: meNo + '_t1', type: 'assign', title: '季度经营分析报告', who: subA,
      start: d(-6), end: d(4), std: '输出 30 页分析报告并通过经营会评审', status: 'todo', imp: 3, urg: 3,
      stages: [st('s1', '数据口径确认与取数', d(-6), d(-2)), st('s2', '报告初稿撰写', d(-1), d(2)), st('s3', '经营会评审与修订', d(3), d(4))] },
    { id: meNo + '_t2', type: 'assign', title: 'Top10 客户续约拜访计划', who: subB,
      start: d(-3), end: d(7), std: '覆盖 Top10 客户，输出拜访排期与风险清单', status: 'todo', imp: 3, urg: 2,
      stages: [st('s1', '客户清单与优先级', d(-3), d(-1)), st('s2', '拜访排期确认', d(0), d(3)), st('s3', '风险清单输出', d(4), d(7))] },
    { id: meNo + '_t3', type: 'assign', title: '新人 30 天带教计划落地', who: subA,
      start: d(-10), end: d(20), std: '新人独立承接 1 个模块需求并通过转正评估', status: 'doing', imp: 2, urg: 1,
      stages: [
        st('s1', '入职第一周陪跑', d(-10), d(-3), { done: true, doneBy: subA, doneAt: d(-3) }),
        st('s2', '模块需求实操', d(-2), d(9), { done: true, doneBy: subA, doneAt: d(1) }),
        st('s3', '转正评估材料', d(10), d(20))
      ] },
    { id: meNo + '_t4', type: 'special', title: '部门数据看板建设',
      start: d(-15), end: d(15), std: '看板覆盖 6 个核心指标，日更可用', status: 'doing', imp: 3, urg: 2,
      stages: [
        st('s1', '需求梳理与指标定义', d(-15), d(-9), { done: true, doneBy: meNo, doneAt: d(-10) }),
        st('s2', '数据源接入', d(-8), d(-2), { done: true, doneBy: meNo, doneAt: d(-3) }),
        st('s3', '看板搭建与试运行', d(-1), d(8)),
        st('s3a', '前端页面搭建', d(-1), d(4), { pid: 's3', who: subC, whoAt: now }),
        st('s3b', '指标口径复核', d(5), d(8), { pid: 's3', who: subB, whoAt: now }),
        st('s4', '验收与推广', d(9), d(15))
      ] },
    { id: meNo + '_t5', type: 'special', title: '部门制度修订（考核细则）',
      start: d(2), end: d(25), std: '形成修订稿并通过部门会签', status: 'todo', imp: 2, urg: 1,
      stages: [st('s1', '问题清单收集', d(2), d(9)), st('s2', '细则起草', d(10), d(18)), st('s3', '会签与发布', d(19), d(25))] },
    /* 示例数据也得守「周末不排活」：按「今天 +N 天」硬算，周五生成就会把临时任务放到周六，
       那天就成了非工作日里唯一的活，看着像自己定的规矩没执行 */
    { id: meNo + '_t6', type: 'temp', title: '回复客户续约邮件',
      start: shiftDay(d(0), 'next'), end: shiftDay(d(0), 'next'), time: '16:00', std: '', status: 'todo', imp: null, urg: 3, stages: [] },
    { id: meNo + '_t7', type: 'temp', title: '采购团建物资',
      start: shiftDay(d(1), 'next'), end: shiftDay(d(1), 'next'), std: '', status: 'todo', imp: null, urg: null, stages: [] }
  ];
  for (const t of T) {
    /* 有阶段的按阶段边界重定任务的起止，没阶段的（临时任务）保持原样 */
    const fit = (t.stages || []).length ? fitDemoStages(t.stages) : null;
    upsertTask(meNo, {
      id: t.id, type: t.type, title: t.title, ownerNo: meNo,
      assigneeNo: t.who || meNo, assignee: t.who && t.who !== meNo ? '' : '我',
      start: (fit && fit.start) || t.start, end: (fit && fit.end) || t.end,
      dueDate: (fit && fit.end) || t.end, time: t.time || '',
      std: t.std, status: t.status, cat1: meNo + '_c2', cat2: meNo + '_c22',
      imp: t.imp, urg: t.urg, stages: t.stages
    }, { demo: true });
  }
  /* 第三条已经移交出去：所有权在承接人手上，我这边只剩发布人身份。
     这条最能说明新版和老版的差别——同一条任务，不是两份副本。 */
  db.prepare(`UPDATE task SET owner_no=?, type='special', intake_status='accepted' WHERE id=?`)
    .run(subA, meNo + '_t3');
  /* 已派人且已加入待办的那一段，给责任人落一条镜像的临时任务 */
  if (subC !== meNo) {
    const p = db.prepare('SELECT * FROM task WHERE id=?').get(meNo + '_t4');
    const stages = parseStages(p.stages);
    const one = stages.find(s => s.id === 's3a');
    if (one) {
      one.joinedAt = now;
      db.prepare('UPDATE task SET stages=? WHERE id=?').run(JSON.stringify(stages), p.id);
      db.prepare(`INSERT OR IGNORE INTO task
        (id,owner_no,publisher_no,assignee_no,type,title,start_date,end_date,due_date,status,stages,
         stage_ref,intake_status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        'st_' + p.id + '_s3a', subC, subC, subC, 'temp', p.title + ' · 前端页面搭建',
        one.start, one.end, one.end, 'todo', '[]', JSON.stringify({ taskId: p.id, stageId: 's3a' }), null, now, now
      );
    }
  }
  /* 下属自己的常规工作，让管理者看板有真实数据可看（每人都有，避免看板出现「今日无节点」的空壳） */
  const SUB_ROUTINE = {
    '产品经理': ['每日站会记录', '周报汇总与提交', '月度经营分析'],
    '数据分析': ['每日数据巡检', '周报汇总与提交', '月度经营分析'],
    '研发工程师': ['每日站会记录', '周报汇总与提交', '版本发布回归'],
    '运营': ['每日运营播报', '周报汇总与提交', '月度活动复盘']
  };
  for (const s of subs) {
    if (db.prepare('SELECT COUNT(*) c FROM rule WHERE owner_no=?').get(s.no).c) continue;
    const [t1, t2, t3] = SUB_ROUTINE[s.role] || ['每日站会记录', '周报汇总与提交', '月度复盘'];
    upsertRule(s.no, { id: s.no + '_dr1', title: t1, cycle: 'day', policy: 'none', active: true, steps: [{ name: '', time: '09:30', policy: 'none' }] });
    upsertRule(s.no, { id: s.no + '_dr2', title: t2, cycle: 'week', policy: 'prev', active: true, steps: [{ name: '', weekday: 5, time: '17:00', policy: 'prev' }] });
    upsertRule(s.no, { id: s.no + '_dr3', title: t3, cycle: 'month', policy: 'prev', active: true, steps: [
      { name: '取数与口径确认', day: 3, time: '10:00', policy: 'prev' },
      { name: '分析初稿撰写', day: 10, time: '18:00', policy: 'prev' },
      { name: '经营会评审', day: 18, time: '14:00', policy: 'next' },
      { name: '归档与复盘', day: 25, time: '16:00', policy: 'prev' }
    ] });
  }
  /* 下属自己的专项任务：没有的话，「下属专项工作推进情况」永远是空的，
     使用者会以为这个模块坏了。给两个人各立一条，阶段进度一眼看得出差别。 */
  const SUB_SPECIAL = [
    ['客户画像标签体系重建', 0, d(-8), d(12), 'doing', [
      ['标签口径对齐', d(-8), d(-3), 1], ['历史数据回刷', d(-2), d(4), 0], ['灰度验证', d(5), d(12), 0]]],
    ['月度活动复盘模板化', 2, d(-4), d(9), 'todo', [
      ['复盘框架确定', d(-4), d(0), 1], ['模板试填', d(1), d(9), 0]]]
  ];
  for (const [title, idx, start, end, status, stages] of SUB_SPECIAL) {
    if (!subs.length) break;
    const owner = subs[idx % subs.length];
    upsertTask(owner.no, {
      id: owner.no + '_sp1', type: 'special', title, ownerNo: owner.no, assigneeNo: owner.no,
      start, end, std: '', status, cat1: null, cat2: null, imp: 2, urg: 1,
      stages: stages.map(s => ({ name: s[0], start: s[1], end: s[2], done: !!s[3] })),
      intakeStatus: null
    }, { demo: true });
  }
  /* 演示里这些下属的常规工作已经在被勾、派给他们的活也已经在推——
     说明他们本来就是这台工作台的使用者，激活标记要跟着一起给，否则
     「我下派的任务」会挂着一批「这个人从没登录过」，自己跟自己打架。 */
  const markActive = db.prepare('UPDATE emp SET activated=1 WHERE no=?');
  markActive.run(meNo);
  for (const s of subs) markActive.run(s.no);
  bumpRev();
  /* 演示数据里，过去周期的常规实例直接视为已完成，避免首屏一片「逾期」 */
  const t0 = todayStr();
  for (const no of [meNo, ...subs.map(s => s.no)]) {
    maintain([no]);
    const rows = db.prepare("SELECT id,start_date,end_date,stages FROM task WHERE owner_no=? AND type='routine' AND status<>'done' AND end_date < ?").all(no, t0);
    const upd = db.prepare("UPDATE task SET status='done',stages=?,updated_at=? WHERE id=?");
    for (const r of rows) {
      const steps = JSON.parse(r.stages || '[]').map(x => Object.assign({}, x, { done: true }));
      upd.run(JSON.stringify(steps), nowStr(), r.id);
    }
  }
  bumpRev();
  return T.length;
}

/* ============ HTTP ============ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};
function sendJSON(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function logOp(actor, action, detail, ip) {
  try { db.prepare('INSERT INTO op_log(actor_no,action,detail,ip,created_at) VALUES(?,?,?,?,?)').run(actor, action, detail || '', ip || '', nowStr()); } catch (e) { }
}
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  /* 慢请求留痕：接口卡住时浏览器那边表现为「页面没反应」，从服务端这头才看得出是哪一步 */
  const started = Date.now();
  res.on('finish', () => {
    const dt = Date.now() - started;
    if (dt > 800) console.log(`[slow] ${req.method} ${p} ${dt}ms`);
  });

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  try {
    /* 版本与更新记录：公开只读，不校验登录（登录页也要能看到版本号）。
       数据源 version.js，前端更新弹窗与顶栏版本号都走这两个接口。 */
    if (p === '/api/version' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, semver: SEMVER, version: getFullVersion(), changelog: getChangelog() });
    }
    if (p === '/api/changelog' && req.method === 'GET') {
      return sendJSON(res, 200, { ok: true, current: SEMVER, versions: getChangelogHistory() });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const no = String(b.no || '').trim(), name = String(b.name || '').trim();
      if (!no || !name) return sendJSON(res, 200, { ok: false, msg: '工号和姓名都要填' });
      const emp = getEmp(no);
      if (!emp) return sendJSON(res, 200, { ok: false, msg: `花名册里没有工号「${no}」，请与管理员核对` });
      if (emp.name !== name) return sendJSON(res, 200, { ok: false, msg: `工号「${no}」对应的姓名不是「${name}」，请核对后再登录` });
      /* 登录过一次就打上激活标记：以后下派任务时能判断「这个人到底收不收得到」。
         没有这个标记就没法在派之前拦住"派给一个从没开通过账号的人"。 */
      db.prepare('UPDATE emp SET activated=1, last_login=? WHERE no=?').run(nowStr(), emp.no);
      logOp(no, 'login', '', ip);
      return sendJSON(res, 200, { ok: true, me: { no: emp.no, name: emp.name, role: emp.role, dept: emp.dept, mgrNo: emp.mgr_no || null } });
    }

    if (p === '/api/state' && req.method === 'GET') {
      const me = url.searchParams.get('me');
      const st = stateFor(me);
      if (!st) return sendJSON(res, 404, { ok: false, msg: '花名册里没有这个工号' });
      return sendJSON(res, 200, { ok: true, ...st });
    }

    if (p === '/api/rev' && req.method === 'GET') {
      const rev = Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v);
      return sendJSON(res, 200, { ok: true, rev });
    }

    if (p === '/api/sync' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      const r = applySync(me, b);
      logOp(me, 'sync', 'rows=' + r.n, ip);
      return sendJSON(res, 200, { ok: true, rows: r.n, errors: r.errors, rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v) });
    }

    /* ---- 0.7.0 动作：接收 / 派发 / 加入待办 / 勾选 / 提醒已读 ---- */
    if (p === '/api/task/accept' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      const r = acceptTask(me, String(b.id || ''));
      if (r.ok) logOp(me, 'accept', b.id, ip);
      return sendJSON(res, 200, { ...r, rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v) });
    }
    if (p === '/api/task/dispatch' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      const r = dispatchTask(me, String(b.id || ''));
      if (r.ok) logOp(me, 'dispatch', b.id + ' n=' + r.n, ip);
      return sendJSON(res, 200, { ...r, rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v) });
    }
    if (p === '/api/stage/join' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      const r = joinStage(me, String(b.id || ''), String(b.stageId || ''));
      if (r.ok) logOp(me, 'stage-join', b.id + '/' + b.stageId, ip);
      return sendJSON(res, 200, { ...r, rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v) });
    }
    if (p === '/api/stage/toggle' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      const r = toggleStage(me, String(b.id || ''), String(b.stageId || ''), b.done);
      if (r.ok) logOp(me, 'stage-toggle', b.id + '/' + b.stageId + '=' + r.done, ip);
      return sendJSON(res, 200, { ...r, rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v) });
    }
    if (p === '/api/task/due' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      const r = setDueDate(me, String(b.id || ''), String(b.date || ''));
      if (r.ok) logOp(me, 'due', b.id + '=' + b.date, ip);
      return sendJSON(res, 200, { ...r, rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v) });
    }
    if (p === '/api/notice/seen' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      const r = markNoticesSeen(me, b.ids);
      return sendJSON(res, 200, { ...r, rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v) });
    }

    if (p === '/api/setmgr' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || ''), target = b.mgrNo ? String(b.mgrNo) : null;
      const emp = getEmp(me);
      if (!emp) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      if (target) {
        if (target === me) return sendJSON(res, 200, { ok: false, msg: '不能把自己设为上级' });
        if (!getEmp(target)) return sendJSON(res, 200, { ok: false, msg: '花名册里没有这个人' });
        /* 防环：目标不能是我的下级（向下追一层） */
        const down = subsOf(me).map(s => s.no);
        if (down.includes(target)) return sendJSON(res, 200, { ok: false, msg: '这是你的下级，不能反向设为上级' });
      }
      db.prepare('UPDATE emp SET mgr_no=? WHERE no=?').run(target, me);
      bumpRev();
      logOp(me, 'setmgr', target || '', ip);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/demo' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      const n = seedDemo(me);
      return sendJSON(res, 200, { ok: true, created: n });
    }

    if (p === '/api/reset' && req.method === 'POST') {
      const b = await readBody(req);
      const me = String(b.me || '');
      if (!getEmp(me)) return sendJSON(res, 403, { ok: false, msg: '未登录' });
      /* 先清知情人名单再删任务：反过来删就找不到指向哪条任务了 */
      db.prepare('DELETE FROM task_observer WHERE task_id IN (SELECT id FROM task WHERE owner_no=?)').run(me);
      db.prepare('DELETE FROM task WHERE owner_no=?').run(me);
      db.prepare('DELETE FROM stage_notice WHERE emp_no=?').run(me);
      db.prepare('DELETE FROM rule WHERE owner_no=?').run(me);
      db.prepare('DELETE FROM cat WHERE owner_no=?').run(me);
      db.prepare('DELETE FROM watch WHERE mgr_no=?').run(me);
      bumpRev();
      logOp(me, 'reset', '', ip);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { ok: false, msg: 'not found' });
  } catch (e) {
    console.error('[api]', p, e);
    return sendJSON(res, 500, { ok: false, msg: String(e && e.message || e) });
  }
});

/* 真实局域网地址：WSL/Hyper-V 的虚拟网卡不是别人能访问的，排前面只会误导人 */
function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|VirtualBox|VMware|Loopback|Tailscale|ZeroTier/i.test(name)) continue;
    for (const it of list || []) if (it.family === 'IPv4' && !it.internal) out.push(it.address);
  }
  const rank = (ip) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 3 : 2;
  return out.sort((a, b) => rank(a) - rank(b));
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  [!] 端口 ${PORT} 已经被占用——服务大概率已经在运行了。`);
    console.log(`      直接在浏览器打开： http://localhost:${PORT}`);
    console.log('      如果打不开，可能是有个残留进程，先用「停止工作台.bat」关掉再启动。');
    console.log('');
  } else {
    console.log('');
    console.log('  [!] 启动失败：' + (e && e.message ? e.message : e));
    console.log('');
  }
  process.exit(1);
});

/* 浏览器会复用 TCP 连接，而 Node 默认 5 秒就把它收掉。
   工作台里两次点击之间经常隔好几秒，一旦复用了一条「服务端已经半关」的连接，
   浏览器只对 GET 重试，POST 会直接报 failed to fetch——用户看到的就是「点保存没反应」。
   抬到 65 秒，比默认安全得多，也不会攒下太多空闲连接（个人工作台并发极低）。 */
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`  Cadence · 初级管理者工作台 v${SEMVER}（MVP）已启动`);
  console.log('  ----------------------------------------');
  console.log(`  本机访问：  http://localhost:${PORT}`);
  const ips = lanIPs();
  if (ips.length) console.log(`  同事访问：  http://${ips[0]}:${PORT}`);
  else console.log('  同事访问：  未检测到局域网地址（可能没连内网）');
  if (ips.length) console.log('              （同事打不开，多半是本机防火墙拦了这个端口）');
  console.log(`  数据库：    ${DB_FILE}`);
  console.log('');
  console.log('  在浏览器打开上面「本机访问」那个地址就能用了。');
  console.log('  这个窗口就是服务本身：可以最小化，但别关掉。');
  console.log('');
});
