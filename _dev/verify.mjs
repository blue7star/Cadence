'use strict';
/* 本地门禁：提交前那道真正会拦人的闸。
 *
 * 为什么自建而不用 ai-native-engineering 的 gates/gate.py：
 * 它的 M1/M3 只比 `HEAD~1...HEAD`，0.4.7–0.4.13 七个版本堆在工作区没提交时，
 * `gate.py --ci` 照样返回 pass。门禁看不见「即将提交的这棵树」，就等于没有门禁。
 * 这里换个口径：先算「现在磁盘上这棵树」的摘要（含未提交、未跟踪），
 * 校验通过才把摘要记下来；pre-commit 再复核摘要没变过。
 *
 *   node _dev/verify.mjs --fast   静态检查（秒级，改一行就跑得动）
 *   node _dev/verify.mjs --full   静态检查 + 版本自检 + e2e（提交前跑这个）
 *   node _dev/verify.mjs --hook   pre-commit 调用：静态检查 + 复核这棵树验过
 *
 * 退出码：0 通过；1 不通过（pre-commit 会据此拦下提交）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const REPORT = path.join(ROOT, '_dev', 'verify-report.json');
const BASE = process.env.CADENCE_BASE || 'http://localhost:8788';
const MODE = process.argv[2] || '--fast';

const checks = [];
function check(name, ok, info = '') {
  checks.push({ name, ok, info });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${info ? '  · ' + info : ''}`);
  return ok;
}

/* ── 1. 语法 ─────────────────────────────────────────────── */
function syntax() {
  const targets = [
    'server.js', 'version.js', 'import-emp.js',
    'public/app.js', 'public/changelog.js'
  ];
  const dev = fs.existsSync(path.join(ROOT, '_dev'))
    ? fs.readdirSync(path.join(ROOT, '_dev')).filter((f) => f.endsWith('.mjs')).map((f) => '_dev/' + f)
    : [];
  const files = [...targets, ...dev].filter((f) => fs.existsSync(path.join(ROOT, f)));
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(f);
  }
  check(`语法检查 ${files.length} 个文件`, bad.length === 0, bad.length ? '看不懂的：' + bad.join(', ') : '');
  return bad.length === 0;
}

/* ── 2. 版本 ─────────────────────────────────────────────── */
function version() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'version.js'), '--check'], { encoding: 'utf8' });
  const out = (r.stdout || '').trim() || (r.stderr || '').trim();
  const ok = check('版本自检（当前版本有登记、结构合法）', r.status === 0, out.replace(/^\[.*?\]\s*/, ''));

  /* CHANGELOG.md 是生成物，改了 version.js 忘了 --write 会让两者说法不一致 */
  const req = createRequire(import.meta.url);
  const v = req(path.join(ROOT, 'version.js'));
  const want = String(v.toMarkdown()).replace(/\r\n/g, '\n').trim();
  const file = path.join(ROOT, 'CHANGELOG.md');
  const got = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim() : '';
  check('CHANGELOG.md 与 version.js 一致', want === got,
    want === got ? '' : '不一致，跑 node version.js --write');
  return ok && want === got;
}

/* ── 3. 契约状态 ─────────────────────────────────────────── */
/* 「复核由没参与实现的人做」写在模板里，三年也不会有一次发生。
   要让它真发生，只能让它在提交时变红。

   第一版只检查「状态写了 PASS 吗」，结果它有四条无障碍通道（都是复核时被指出的）：
   ① 永远不写 PASS → 直接放行；② 四行全填「无」→ 放行；
   ③ 正文里先放一行「示例：**状态**：PLANNED」→ 真正的 PASS 躲过检查；④ `_` 开头或子目录 → 整体跳过。
   现在的口径：
   - 状态行全文件唯一、值必须在枚举里；
   - 交付段写了东西 = 这件事做完了 → 必须 PASS 且有复核记录；
     停在未复核状态可以，但必须在 issues.md 未解决表里挂一个编号（欠债登记，不是豁免）；
   - 复核对象必须是 16 位树摘要，且等于当前 --full 报告里的摘要 → 复核记录绑在具体的树上；
   - 没有 --full 证据时不许写 PASS（NOT_RUN 不等于 PASS）。
   机器只能证明「有人写下过一条指向这版代码的复核记录」，证明不了复核真的发生了——那部分仍归人。 */
function contracts() {
  const dir = path.join(ROOT, 'docs', 'contracts');
  if (!fs.existsSync(dir)) return check('契约状态与复核记录', false, '找不到 docs/contracts/');
  const rep = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : null;
  const live = rep && rep.full && rep.ok ? rep.digest : null;

  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.md') && e.name !== '_template.md') files.push(path.join(d, e.name));
    }
  })(dir);

  const V = ['PLANNED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'PASS'];
  const unresolved = fs.existsSync(path.join(ROOT, 'issues.md'))
    ? fs.readFileSync(path.join(ROOT, 'issues.md'), 'utf8').split('## 已解决')[0] : '';
  const bad = [];

  for (const p of files) {
    const name = path.relative(dir, p).split(path.sep).join('/');
    const s = fs.readFileSync(p, 'utf8');

    const sts = [...s.matchAll(/\*\*状态\*\*[：:]\s*`?([A-Z_]+)`?/g)].map((m) => m[1]);
    if (sts.length !== 1) { bad.push(`${name}：状态行出现 ${sts.length} 次（必须恰好 1 次）`); continue; }
    const st = sts[0];
    if (!V.includes(st)) { bad.push(`${name}：状态「${st}」不在 ${V.join('/')} 里`); continue; }

    /* 交付段（第 2 段「实际改了」）有没有内容 */
    const d = /##\s*2\.\s*交付[\s\S]*?-\s*\*\*实际改了\*\*[：:]\s*([\s\S]*?)(?=\n-\s*\*\*|##\s*3\.)/.exec(s);
    const delivered = d ? d[1].trim() : '';
    const hasDelivered = !!delivered && !/^(待填|)$/.test(delivered);

    if (hasDelivered && st !== 'PASS') {
      const debt = /\*\*状态\*\*[：:][^\n]*issues\.md[^\n]*?[#＃](\d+)/.exec(s);
      if (!debt || !new RegExp(`\\|\\s*${debt[1]}\\s*\\|`).test(unresolved)) {
        bad.push(`${name}：已交付但状态是 ${st}，且没在 issues.md「未解决」里挂编号`);
      }
      continue;
    }
    if (st !== 'PASS') continue;

    if (!live) { bad.push(`${name}：标了 PASS，但没有任何一次 --full 的绿证据`); continue; }

    const seg = s.split(/##\s*3\.\s*复核/)[1] || '';
    const val = (k) => {
      const m = seg.match(new RegExp(`-\\s*[^\\n]*${k}[^：:]*[：:]\\s*([^\\n]*)`));
      return m ? m[1].trim() : '';
    };
    const way = val('复核方式');
    const obj = val('复核对象');
    const verdict = val('结论');
    const found = val('发现的问题');
    const holes = [];
    if (!/^(新开的对话|独立的子代理|他人)/.test(way)) holes.push('复核方式（要写明是谁、哪种方式）');
    if (!/树摘要\s*`?[0-9a-f]{16}`?/.test(obj)) holes.push('复核对象（必须写 16 位树摘要）');
    else if (!obj.includes(live)) holes.push(`复核对象不是当前这棵树（报告是 ${live}）`);
    if (!/^(通过|有条件通过|打回)/.test(verdict)) holes.push('结论（通过／有条件通过／打回）');
    if (!/(^无$|#\d+)/.test(found)) holes.push('发现的问题（写编号，或「无」）');
    if (holes.length) bad.push(`${name}：状态 PASS 但 ${holes.join('、')}`);
  }

  return check(`契约状态 ${files.length} 份（交付即须复核，复核绑树摘要）`, bad.length === 0,
    bad.length ? bad.join('；') : '');
}

/* ── 4. 这棵树的摘要 ─────────────────────────────────────── */
/* 覆盖「已跟踪 + 已暂存 + 未跟踪但没被忽略」的文件，也就是 git add -A 之后要进库的那批。
   工作区脏不脏不影响算摘要——脏状态正是要被验的对象。

   但摘要只算「会改变运行行为」的文件，文档排除在外。两个原因，都是实测出来的：
   1) 契约要把摘要写进自己，摘要又算了契约 → 写完就变，这个锚点永远对不上（自指）；
   2) 纯文档改动不改变任何可观察行为，为它重跑 90 秒 e2e 是浪费，
      而 AGENTS.md 第 2 节本来就允许 G0 只跑 --fast。
   文档单独算一个 docsDigest，只作记录，不参与放行判断。 */
const DOC_ONLY = /^(docs\/|\.agents\/|CHANGELOG\.md$|README\.md$|DEVELOPMENT\.md$|AGENTS\.md$|issues\.md$)/;

function treeDigest() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
  const files = out.split('\0').filter(Boolean).sort();
  const h = crypto.createHash('sha256');
  const dh = crypto.createHash('sha256');
  const each = {};
  let codeFiles = 0;
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, f)); } catch { continue; } /* 已删除、待提交 */
    each[f] = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const isDoc = DOC_ONLY.test(f);
    const hh = isDoc ? dh : h;
    if (!isDoc) codeFiles++;
    hh.update(f); hh.update('\0'); hh.update(String(buf.length)); hh.update('\0'); hh.update(buf);
  }
  return {
    digest: h.digest('hex').slice(0, 16), docsDigest: dh.digest('hex').slice(0, 16),
    files: Object.keys(each).length, codeFiles, each
  };
}

function headRev() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim();
  } catch { return ''; }
}

/* 摘要对不上时，指出是哪些文件变了——只说「树变了」等于让人自己猜 */
function diffPaths(a = {}, b = {}) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => a[k] !== b[k]).sort();
}

/* ── 4. 服务与 e2e ───────────────────────────────────────── */
async function served() {
  try {
    const r = await fetch(BASE + '/api/version');
    const j = await r.json();
    const want = createRequire(import.meta.url)(path.join(ROOT, 'version.js')).SEMVER;
    check('服务在跑，且版本与本机代码一致', j.semver === want,
      j.semver === want ? `v${want}` : `服务在跑 v${j.semver}，代码是 v${want}——重启服务再验`);
    return j.semver === want;
  } catch (e) {
    check('服务在跑，且版本与本机代码一致', false, `连不上 ${BASE}，先双击「启动工作台.bat」`);
    return false;
  }
}

function e2e() {
  const r = spawnSync(process.execPath, [path.join(ROOT, '_dev', 'e2e.mjs'), BASE],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout || '') + (r.stderr || '');
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const total = out.split('\n').filter((l) => /^(PASS|FAIL)\s/.test(l)).length;
  check(`e2e ${total} 项`, r.status === 0, fails.length ? fails.slice(0, 6).join(' | ') : '');
  /* 没有 FAIL 行却退出码非 0，说明 e2e 中途崩了（页面崩、CDP 断）——
     不打印尾部就只能看到「只跑了 N 项」，完全没法定位。 */
  if (r.status !== 0 && !fails.length) {
    console.log(out.split('\n').slice(-12).join('\n'));
  }
  return r.status === 0;
}

/* ── 5. 入口 ─────────────────────────────────────────────── */
async function main() {
  console.log(`\n[校验] ${MODE}  ${path.basename(ROOT)}\n`);
  let ok = syntax() && version() && contracts();

  if (MODE === '--full') {
    const up = await served();
    /* 服务没起或版本旧，e2e 验的是旧代码，跑了也没意义 */
    ok = up ? e2e() && ok : false;
  }

  const tree = treeDigest();

  if (MODE === '--hook') {
    /* 静态问题先报，报完再看有没有完整的验证记录 */
    const rep = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : null;
    const bound = !!rep && rep.digest === tree.digest && rep.full === true && rep.ok === true;
    let why = '';
    if (bound) why = `${rep.digest} · ${rep.at.slice(11, 19)} 验过`;
    else if (!rep) why = '从来没有验证记录 → 先跑 node _dev/verify.mjs --full';
    else if (rep.digest !== tree.digest) {
      const d = diffPaths(rep.each, tree.each);
      why = `验过之后又改了 ${d.length} 个文件（${d.slice(0, 5).join(', ')}${d.length > 5 ? ' …' : ''}）→ 重跑 --full`;
    } else if (!rep.full) why = '这棵树只跑过 --fast，缺 e2e → 重跑 --full';
    else if (!rep.ok) why = '上次完整校验没通过 → 修完重跑 --full';
    else why = `${rep.digest} 的记录不完整 → 重跑 --full`;
    check('这棵树跑过完整校验', bound, why);
    ok = ok && bound;
  }

  /* 只有 --full 落证据。--fast 不写报告：
     它是「改一行先看一眼」的秒级自检，一旦也写报告，就会把上一次 --full 的绿记录覆盖成
     full=false，pre-commit 立刻拦下——而且真正的证据也丢了。证据只许被 --full 更新。 */
  if (MODE === '--full') {
    const report = {
      at: new Date().toISOString(), mode: MODE, head: headRev(),
      digest: tree.digest, docsDigest: tree.docsDigest, files: tree.files, codeFiles: tree.codeFiles,
      each: tree.each, full: true, ok, checks
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 1), 'utf8');
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (ok) {
    console.log(`[通过] ${checks.length} 项全绿 · 树 ${tree.digest}`
      + `（${tree.codeFiles} 个代码文件 / ${tree.files - tree.codeFiles} 个文档）`);
    if (MODE === '--full') console.log('可以提交：git add -A && git commit -m "…"');
    else console.log('--fast 只做静态检查，不留证据；提交前要跑 --full');
    process.exit(0);
  }
  console.log(`[不通过] ${failed.length}/${checks.length} 项有问题，提交会被拦下：`);
  for (const f of failed) console.log(`  - ${f.name}${f.info ? '：' + f.info : ''}`);
  process.exit(1);
}

main();
