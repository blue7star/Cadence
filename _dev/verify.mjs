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

/* ── 3. 这棵树的摘要 ─────────────────────────────────────── */
/* 覆盖「已跟踪 + 已暂存 + 未跟踪但没被忽略」的文件，也就是 git add -A 之后要进库的那批。
   工作区脏不脏不影响算摘要——脏状态正是要被验的对象。 */
function treeDigest() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
  const files = out.split('\0').filter(Boolean).sort();
  const h = crypto.createHash('sha256');
  const each = {};
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, f)); } catch { continue; } /* 已删除、待提交 */
    each[f] = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    h.update(f); h.update('\0'); h.update(String(buf.length)); h.update('\0'); h.update(buf);
  }
  return { digest: h.digest('hex').slice(0, 16), files: Object.keys(each).length, each };
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
  return r.status === 0;
}

/* ── 5. 入口 ─────────────────────────────────────────────── */
async function main() {
  console.log(`\n[校验] ${MODE}  ${path.basename(ROOT)}\n`);
  let ok = syntax() && version();

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

  if (MODE !== '--hook') {
    const report = {
      at: new Date().toISOString(), mode: MODE, digest: tree.digest, files: tree.files,
      each: tree.each, full: MODE === '--full', ok, checks
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 1), 'utf8');
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (ok) {
    console.log(`[通过] ${checks.length} 项全绿 · 树 ${tree.digest}（${tree.files} 个文件）`);
    if (MODE === '--full') console.log('可以提交：git add -A && git commit -m "…"');
    process.exit(0);
  }
  console.log(`[不通过] ${failed.length}/${checks.length} 项有问题，提交会被拦下：`);
  for (const f of failed) console.log(`  - ${f.name}${f.info ? '：' + f.info : ''}`);
  process.exit(1);
}

main();
