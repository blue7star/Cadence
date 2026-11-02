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
   routine_id,plan_date,source_id,detached,intake_status,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

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
      rule.id, built[0].plan, null, 0, null, now, now
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
}

/* ============ 身份与可见范围 ============ */
function getEmp(no) { return db.prepare('SELECT * FROM emp WHERE no=? AND active=1').get(String(no || '')); }
function subsOf(no) { return db.prepare('SELECT no,name,role,dept FROM emp WHERE mgr_no=? AND active=1 AND no<>?').all(no, no); }

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

  const placeholders = ownerNos.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM task WHERE owner_no IN (${placeholders}) OR assignee_no=?`)
    .all(...ownerNos, meNo)
    .filter(r => r.owner_no === meNo || r.assignee_no === meNo || r.type === 'routine');

  const tasks = rows.map(r => ({
    id: r.id, type: r.type, title: r.title, ownerNo: r.owner_no, assigneeNo: r.assignee_no,
    assignee: r.assignee_no === meNo ? '我' : (names[r.assignee_no] || ''),
    start: r.start_date, end: r.end_date, time: r.time || '', std: r.std || '',
    status: r.status || 'todo', cat1: r.cat1, cat2: r.cat2,
    imp: r.imp == null ? null : Number(r.imp), urg: r.urg == null ? null : Number(r.urg),
    stages: JSON.parse(r.stages || '[]'),
    routineId: r.routine_id || null, planDate: r.plan_date || null,
    sourceId: r.source_id || null, detached: !!r.detached,
    intakeStatus: r.intake_status || null, auto: !!r.routine_id
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
    .map(w => ({ id: w.id, subNo: w.sub_no, ruleId: w.rule_id }));

  /* 可见范围内的常规规则元信息（下属的实例要显示标题与周期） */
  const routines = db.prepare(`SELECT id,owner_no,title,cycle FROM rule WHERE owner_no IN (${placeholders})`)
    .all(...ownerNos)
    .map(r => ({ id: r.id, ownerNo: r.owner_no, title: r.title, cycle: r.cycle }));

  const roster = db.prepare('SELECT no,name,role,dept,mgr_no FROM emp WHERE active=1 ORDER BY no').all()
    .map(e => ({ no: e.no, name: e.name, role: e.role, dept: e.dept, mgrNo: e.mgr_no }));

  const holidays = db.prepare('SELECT date,kind,name FROM holiday').all();

  return {
    rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v),
    today: todayStr(),
    me: {
      no: me.no, name: me.name, role: me.role, dept: me.dept,
      mgrNo: me.mgr_no || null,
      mgr: mgr ? { no: mgr.no, name: mgr.name, role: mgr.role, dept: mgr.dept } : null
    },
    subs: subs.map(s => ({ no: s.no, name: s.name, role: s.role, dept: s.dept })),
    roster, cats, rules, tasks, watch, holidays, routines
  };
}

/* ============ 写操作 ============ */
function bumpRev() {
  db.prepare('UPDATE meta SET v = CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k=?').run('rev');
}

function upsertTask(meNo, t) {
  const exist = db.prepare('SELECT * FROM task WHERE id=?').get(t.id);
  if (exist) {
    if (exist.owner_no !== meNo && exist.assignee_no !== meNo) return false;
    db.prepare(`UPDATE task SET title=?,std=?,start_date=?,end_date=?,time=?,status=?,cat1=?,cat2=?,
                imp=?,urg=?,stages=?,detached=?,intake_status=?,updated_at=? WHERE id=?`)
      .run(t.title, t.std || '', t.start, t.end, t.time || '', t.status || 'todo',
        t.cat1 || null, t.cat2 || null,
        t.imp == null || t.imp === '' ? null : Number(t.imp),
        t.urg == null || t.urg === '' ? null : Number(t.urg),
        JSON.stringify(t.stages || []), t.detached ? 1 : 0,
        t.intakeStatus || null, nowStr(), t.id);
    return true;
  }
  if (t.ownerNo !== meNo && t.assigneeNo !== meNo) return false;
  const now = nowStr();
  insTaskStmt.run(
    t.id, t.ownerNo || meNo, t.assigneeNo || meNo, t.type || 'temp', t.title, t.std || '',
    t.start, t.end, t.time || '', t.status || 'todo', t.cat1 || null, t.cat2 || null,
    t.imp == null || t.imp === '' ? null : Number(t.imp),
    t.urg == null || t.urg === '' ? null : Number(t.urg),
    JSON.stringify(t.stages || []), t.routineId || null, t.planDate || null,
    t.sourceId || null, t.detached ? 1 : 0, t.intakeStatus || null, now, now
  );
  return true;
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
  ensureInstances(db.prepare('SELECT * FROM rule WHERE id=?').get(r.id), w.from, w.to);
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
    const r = db.prepare('SELECT owner_no FROM task WHERE id=?').get(id);
    if (r && r.owner_no === meNo) n += db.prepare('DELETE FROM task WHERE id=?').run(id).changes;
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
  for (const t of body.tasks || []) if (upsertTask(meNo, t)) n++;
  for (const w of body.watch || []) {
    if (w.mgrNo && w.mgrNo !== meNo) continue;
    db.prepare('INSERT OR IGNORE INTO watch(id,mgr_no,sub_no,rule_id) VALUES(?,?,?,?)')
      .run(w.id, meNo, w.subNo, w.ruleId);
    n++;
  }
  if (n) bumpRev();
  return n;
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
  const T = [
    ['季度经营分析报告', 'assign', pick(1), d(-6), d(4), '输出 30 页分析报告并通过经营会评审', 'doing', 3, 3, [
      ['数据口径确认与取数', d(-6), d(-2), 1], ['报告初稿撰写', d(-1), d(2), 0], ['经营会评审与修订', d(3), d(4), 0]]],
    ['Top10 客户续约拜访计划', 'assign', pick(0), d(-3), d(7), '覆盖 Top10 客户，输出拜访排期与风险清单', 'doing', 3, 2, [
      ['客户清单与优先级', d(-3), d(-1), 1], ['拜访排期确认', d(0), d(3), 0], ['风险清单输出', d(4), d(7), 0]]],
    ['新人 30 天带教计划落地', 'assign', pick(3), d(-10), d(20), '新人独立承接 1 个模块需求并通过转正评估', 'todo', 2, 1, []],
    ['部门数据看板建设', 'special', meNo, d(-15), d(15), '看板覆盖 6 个核心指标，日更可用', 'doing', 3, 2, [
      ['需求梳理与指标定义', d(-15), d(-9), 1], ['数据源接入', d(-8), d(-2), 1], ['看板搭建与试运行', d(-1), d(8), 0], ['验收与推广', d(9), d(15), 0]]],
    ['部门制度修订（考核细则）', 'special', meNo, d(2), d(25), '形成修订稿并通过部门会签', 'todo', 2, 1, [
      ['问题清单收集', d(2), d(9), 0], ['细则起草', d(10), d(18), 0], ['会签与发布', d(19), d(25), 0]]],
    ['回复客户续约邮件', 'temp', meNo, d(0), d(0), '', 'todo', null, 3, []],
    ['采购团建物资', 'temp', meNo, d(1), d(1), '', 'todo', null, null, []]
  ];
  let i = 0;
  for (const [title, type, who, start, end, std, status, imp, urg, stages] of T) {
    i++;
    upsertTask(meNo, {
      id: meNo + '_t' + i, type, title, ownerNo: meNo, assigneeNo: who,
      assignee: who === meNo ? '我' : '', start, end, time: type === 'temp' && i === 6 ? '16:00' : '',
      std, status, cat1: meNo + '_c2', cat2: meNo + '_c22', imp, urg,
      stages: stages.map(s => ({ name: s[0], start: s[1], end: s[2], done: !!s[3] })),
      intakeStatus: type === 'assign' ? (who === meNo ? null : 'pending') : null
    });
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
  return i;
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

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  try {
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const no = String(b.no || '').trim(), name = String(b.name || '').trim();
      if (!no || !name) return sendJSON(res, 200, { ok: false, msg: '工号和姓名都要填' });
      const emp = getEmp(no);
      if (!emp) return sendJSON(res, 200, { ok: false, msg: `花名册里没有工号「${no}」，请与管理员核对` });
      if (emp.name !== name) return sendJSON(res, 200, { ok: false, msg: `工号「${no}」对应的姓名不是「${name}」，请核对后再登录` });
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
      const n = applySync(me, b);
      logOp(me, 'sync', 'rows=' + n, ip);
      return sendJSON(res, 200, { ok: true, rows: n, rev: Number(db.prepare('SELECT v FROM meta WHERE k=?').get('rev').v) });
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
      db.prepare('DELETE FROM task WHERE owner_no=?').run(me);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Cadence · 初级管理者工作台（MVP）已启动');
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
