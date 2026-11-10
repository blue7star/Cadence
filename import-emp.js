'use strict';
/**
 * 花名册导入（账号导入）。零依赖，直接写 data/workbench.db 的 emp 表。
 *
 * 用法：
 *   node --no-warnings import-emp.js 花名册.csv            校验并写入
 *   node --no-warnings import-emp.js 花名册.csv --dry-run  只校验，不写库
 *
 * CSV 列（第一行可以是表头，会被识别并跳过）：
 *   工号,姓名,岗位,部门,上级工号
 *   1012,王磊,产品组组长,产品部,1001
 * 说明：
 *   - 只有工号、姓名必填，岗位/部门/上级工号可以留空；
 *   - 上级工号三种写法：填工号 = 按表设定；留空 = 这次不动（保留本人自己选的，不会被冲掉）；
 *     填 `-` = 清空上级（写错了要撤掉时用）；
 *   - 上级工号可以是本文件里出现的人，也可以是库里已有的人；
 *   - 同工号重复导入是「更新」不是报错（姓名/岗位/部门/上级会被覆盖，账号重新启用）；
 *   - 全量校验通过才写库，有一行错就整批不写，避免导入一半；
 *   - 支持 Excel 存的「CSV UTF-8」（带 BOM），也支持 `#` 开头的注释行。
 *
 * 离职：把该工号从 CSV 里删掉不会自动停用（避免误删整批人）。要停用某个人，执行：
 *   node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('data/workbench.db')
 *     .prepare('UPDATE emp SET active=0 WHERE no=?').run('1005')"
 * 停用后他登录不了，也不会出现在任何人的下属里，历史数据不受影响。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
/* 和 server.js 同一个口径：默认写 data/workbench.db，`CADENCE_DB` 可以指到别处。
   e2e 的花名册用例（造 1019、改上级、删测试账号）必须落在测试库副本上，
   否则「跑一次自检」就会往真实花名册里塞人、改别人的上级。 */
const DB_FILE = process.env.CADENCE_DB
  ? path.resolve(process.env.CADENCE_DB)
  : path.join(ROOT, 'data', 'workbench.db');

/* ---------- CSV 解析（够用即可：引号包裹、字段内逗号、"" 转义） ---------- */
function parseLine(line) {
  const out = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const HEADER_WORDS = ['工号', '姓名'];

function parseCsv(raw) {
  const rows = [];
  const text = String(raw).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const cells = parseLine(line);
    // 表头：前两列是「工号」「姓名」
    if (HEADER_WORDS.every((w, k) => (cells[k] || '').includes(w))) continue;
    rows.push({
      lineNo: i + 1,
      no: cells[0] || '',
      name: cells[1] || '',
      role: cells[2] || '',
      dept: cells[3] || '',
      // 上级列三种写法：工号 = 按表设定；留空 = 这次不动（保留本人自己选的）；`-` = 清空
      mgrNo: cells[4] === '-' ? '' : (cells[4] || ''),
      mgrClear: cells[4] === '-',
    });
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);

  /* 停用 / 启用单人：离职、返聘不用碰 CSV */
  const toggle = args.includes('--off') ? 'off' : args.includes('--on') ? 'on' : null;
  if (toggle) {
    const no = args[args.indexOf('--' + toggle) + 1];
    if (!no || no.startsWith('--')) {
      console.error(`\n  用法：node --no-warnings import-emp.js --${toggle} 工号\n`);
      process.exit(1);
    }
    if (!fs.existsSync(DB_FILE)) {
      console.error('\n  还没有数据库（data/workbench.db）。先启动一次工作台让它建库。\n');
      process.exit(1);
    }
    const db = new DatabaseSync(DB_FILE);
    const emp = db.prepare('SELECT no,name,active FROM emp WHERE no=?').get(no);
    if (!emp) {
      console.error(`\n  花名册里没有工号 ${no}，先用 CSV 把人导进来。\n`);
      process.exit(1);
    }
    const active = toggle === 'on' ? 1 : 0;
    db.prepare('UPDATE emp SET active=? WHERE no=?').run(active, no);
    /* 停用即下线：会话不跟着清，最长能再用 30 天。服务端每次请求也会查 active 兜底，
       这里主动删是为了不让「已停用」的人还挂着一条看起来有效的会话。 */
    if (!active) db.prepare('DELETE FROM sess WHERE no=?').run(String(no));
    db.prepare('UPDATE meta SET v = CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k=?').run('rev');
    console.log('');
    console.log(active
      ? `  已启用：${emp.name}（${no}），可以正常登录了。`
      : `  已停用：${emp.name}（${no}）。此人登录不了，也不再出现在任何人的下属里；之前的任务和日历记录都还在。`);
    console.log('');
    return;
  }

  const dryRun = args.includes('--dry-run');
  const file = args.find(a => !a.startsWith('--'));

  if (!file) {
    console.log('');
    console.log('  用法：node --no-warnings import-emp.js 花名册.csv [--dry-run]');
    console.log('        node --no-warnings import-emp.js --off 工号    停用（离职）');
    console.log('        node --no-warnings import-emp.js --on  工号    重新启用');
    console.log('');
    console.log('  CSV 每行：工号,姓名,岗位,部门,上级工号');
    console.log('  模板见仓库根目录 emp-template.csv（Excel 打开填好另存为「CSV UTF-8」即可）');
    console.log('');
    process.exit(1);
  }
  const abs = path.resolve(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.error(`\n  找不到文件：${abs}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(DB_FILE)) {
    console.error('\n  还没有数据库（data/workbench.db）。先启动一次工作台让它建库，再导入。\n');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(abs, 'utf8'));
  if (!rows.length) {
    console.error('\n  文件里没有可导入的行（是不是只有表头？）。\n');
    process.exit(1);
  }

  const db = new DatabaseSync(DB_FILE);
  const existing = new Map(db.prepare('SELECT no, mgr_no FROM emp').all().map(r => [r.no, r]));
  const inFile = new Map();
  const errors = [];

  for (const r of rows) {
    const at = `第 ${r.lineNo} 行`;
    if (!r.no) { errors.push(`${at}：工号为空`); continue; }
    if (!r.name) { errors.push(`${at}：姓名为空（工号 ${r.no}）`); continue; }
    if (/\s/.test(r.no)) errors.push(`${at}：工号「${r.no}」里不能有空格`);
    if (inFile.has(r.no)) errors.push(`${at}：工号 ${r.no} 在本文件里重复出现（第 ${inFile.get(r.no).lineNo} 行）`);
    if (r.mgrNo && r.mgrNo === r.no) errors.push(`${at}：${r.name}（${r.no}）的上级写成了自己`);
    inFile.set(r.no, r);
  }
  // 上级必须能在「本文件 + 现有库」里找到
  for (const r of rows) {
    if (!r.mgrNo || r.mgrNo === r.no) continue;
    if (!inFile.has(r.mgrNo) && !existing.has(r.mgrNo)) {
      errors.push(`第 ${r.lineNo} 行：上级工号 ${r.mgrNo} 不在花名册里（先把上级本人加进文件或库）`);
    }
  }

  if (errors.length) {
    console.error(`\n  发现 ${errors.length} 处问题，本次没有写入任何数据：`);
    errors.forEach(e => console.error('    - ' + e));
    console.error('\n  改好再跑一次。\n');
    process.exit(1);
  }

  /* 上级列留空 = 「这次没这个信息」，不是「把上级清空」。
     本人登录后自己选的上级也写在同一列 mgr_no 上，不能被一次留空的导入冲掉：
     COALESCE 取新值优先、留空时保留库里原值。要真的改上级就填具体工号。 */
  const ins = db.prepare(`INSERT INTO emp(no,name,role,dept,mgr_no,active,created_at) VALUES(?,?,?,?,?,1,?)
    ON CONFLICT(no) DO UPDATE SET name=excluded.name, role=excluded.role, dept=excluded.dept,
    mgr_no=COALESCE(excluded.mgr_no, emp.mgr_no), active=1`);
  const now = new Date().toISOString();
  let added = 0, updated = 0, mgrWritten = 0, mgrKept = 0, mgrCleared = 0;
  const stillNoMgr = [];
  if (!dryRun) {
    const clearMgr = db.prepare('UPDATE emp SET mgr_no=NULL WHERE no=?');
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const old = existing.get(r.no);
        ins.run(r.no, r.name, r.role || null, r.dept || null, r.mgrNo || null, now);
        if (r.mgrClear) clearMgr.run(r.no);
        if (!old) added++; else updated++;
        if (r.mgrClear) { if (old && old.mgr_no) mgrCleared++; else stillNoMgr.push(r.name); }
        else if (r.mgrNo) { if (!old || old.mgr_no !== r.mgrNo) mgrWritten++; }
        else if (old && old.mgr_no) mgrKept++;
        else stillNoMgr.push(r.name);
      }
      // 花名册变了，前端要重新拉一次数据才能看到新的下属
      db.prepare('UPDATE meta SET v = CAST(CAST(v AS INTEGER)+1 AS TEXT) WHERE k=?').run('rev');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      console.error('\n  写入失败，已回滚：' + e.message + '\n');
      process.exit(1);
    }
  } else {
    for (const r of rows) {
      const old = existing.get(r.no);
      if (old) updated++; else added++;
      if (r.mgrClear) { if (old && old.mgr_no) mgrCleared++; else stillNoMgr.push(r.name); }
      else if (r.mgrNo) { if (!old || old.mgr_no !== r.mgrNo) mgrWritten++; }
      else if (old && old.mgr_no) mgrKept++;
      else stillNoMgr.push(r.name);
    }
  }

  console.log('');
  console.log(`  ${dryRun ? '[试运行，未写库] ' : ''}花名册导入完成：新增 ${added} 人，更新 ${updated} 人，共 ${rows.length} 行。`);
  if (mgrWritten) console.log(`  上级关系：本次按表写入 ${mgrWritten} 人。`);
  if (mgrCleared) console.log(`  上级关系：本次清空 ${mgrCleared} 人（表里写的是 -）。`);
  if (mgrKept) console.log(`  上级关系：${mgrKept} 人表里没填，保留了他们自己选的上级（不会被清空）。`);
  if (stillNoMgr.length) {
    console.log(`  上级关系：${stillNoMgr.length} 人现在还没有上级（${stillNoMgr.join('、')}），登录后会自己选。`);
  }
  if (!dryRun) console.log('  导入后让相关同事刷新页面即可；花名册已生效，不用重启服务。');
  console.log('');
}

main();
