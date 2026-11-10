'use strict';
/* 门禁的反面用例：拿已知的绕法去打 `verify.mjs`，看它是不是真红。
 *
 * 为什么需要这个文件：`contracts()` 改到第四版，每一版都是「复核指出一种绕法 → 补一条判断」。
 * 补完从来没人证明它真的拦住了；下一次改别的规则，很容易又把门开回去。
 * 这里把历次被指出的绕法固化成用例——绕法再出现，这里先红，不用等人复核。
 *
 * 做法：临时改一份契约 → 跑 `verify.mjs --fast` → 期望非 0 → 还原。
 * 一律在 finally 里还原；跑完检查文件内容与开跑时逐字节一致，不一致就报失败（说明还原坏了）。
 *
 *   node _dev/gate-selftest.mjs      单独跑（退出码 0 = 全部绕法都被拦住）
 * 由 `verify.mjs` 在每轮校验里自动调用（`CADENCE_NO_SELFTEST=1` 可关，递归时用）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const DIR = path.join(ROOT, '.agents', 'archive', 'contracts');
const VERIFY = path.join(ROOT, '_dev', 'verify.mjs');
/* 锚点账本是后加的，第一版提交前 HEAD 里没有它——「改写旧记录」这条用例只能等它进过版本库再跑。 */
const anchorsAtHead = spawnSync('git', ['show', 'HEAD:.agents/archive/pass-anchors.md'],
  { cwd: ROOT, encoding: 'utf8' }).status === 0;

function runFast() {
  const r = spawnSync(process.execPath, [VERIFY, '--fast'], {
    encoding: 'utf8',
    env: { ...process.env, CADENCE_NO_SELFTEST: '1', CADENCE_NO_REPORT: '1' }
  });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

const pick = (kw) => fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.md') && f !== '_template.md' && f.includes(kw))[0];

const DELIVERED = pick('三级节点');      /* 已交付；2026-11-05 已转 PASS，用例自己把它降回 READY_FOR_REVIEW 来造场景 */
const DEFERRED = pick('阶段责任人');     /* 未实施、PLANNED，挂着 #18 */
const PASSED = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.md') && f !== '_template.md')
  .find((f) => /\*\*状态\*\*[：:]\s*`?PASS`?/.test(fs.readFileSync(path.join(DIR, f), 'utf8')));

/* 模板第 2 段：用来造「照抄占位符」这种绕法 */
function templateSeg2() {
  const t = fs.readFileSync(path.join(DIR, '_template.md'), 'utf8');
  const heads = [...t.matchAll(/^##[ \t]+([^\n]*)$/gm)]
    .map((m) => ({ text: m[1], start: m.index, bodyStart: m.index + m[0].length }));
  const a = heads.find((h) => h.text.includes('交付'));
  const b = heads.find((h) => h.text.includes('复核'));
  return a && b && a.start < b.start ? t.slice(a.bodyStart, b.start) : '';
}

const cases = [
  {
    name: '第 3 段标题少一个点（`## 3 复核`）也不许跳过',
    file: DELIVERED,
    /* 少一个点 + 复核段写「通过」，状态降回 READY_FOR_REVIEW（挂 #19，未被别的契约占用）。
       标题认不出来就会跳过第 3 段，看不到「结论已通过」，也就不会红。 */
    mutate: (s) => s
      .replace(/\*\*状态\*\*[：:][^\n]*/, '**状态**：`READY_FOR_REVIEW`（见 `issues.md` #19）')
      .replace('## 3. 复核', '## 3 复核')
      .replace(/- 结论：[^\n]*/, '- 结论：通过')
  },
  {
    name: '第 2 段标题少一个点 + 交付删空，不许免检',
    file: DELIVERED,
    mutate: (s) => s.replace(/## 2\. 交付[^\n]*\n[\s\S]*?(?=## 3)/, '## 2 交付\n\n')
  },
  {
    name: '照抄模板占位符不算交付',
    file: DELIVERED,
    mutate: (s) => s.replace(/## 2\. 交付[^\n]*\n[\s\S]*?(?=## 3)/, '## 2. 交付\n\n' + templateSeg2() + '\n')
  },
  {
    name: '第 1 段标题里出现「交付」二字，不能冒充第 2 段',
    file: DELIVERED,
    /* 第七种绕法（第六轮复核找出来的）：靠标题关键字找段落，
       `## 1. 任务（交付前必读）` 排在前面就会被当成交付段，
       真正的交付段改名 `## 2. 记录`、内容删空，也能绿。现在按编号认段。 */
    mutate: (s) => s
      .replace('## 1. 任务', '## 1. 任务（交付前必读）')
      .replace(/## 2\. 交付[^\n]*\n[\s\S]*?(?=## 3)/, '## 2. 记录\n\n')
  },
  {
    name: '挂一个不在「未解决」表里的编号不算欠债',
    file: DELIVERED,
    /* 状态降回 READY_FOR_REVIEW，欠债编号写一个不存在的 #999 */
    mutate: (s) => s.replace(/\*\*状态\*\*[：:][^\n]*/, '**状态**：`READY_FOR_REVIEW`（见 `issues.md` #999）')
  },
  {
    name: '一个编号不许被两份契约共用',
    file: DELIVERED,
    /* 阶段责任人挂着 #18（PLANNED，状态行后 300 字内可见）。让三级节点也挂 #18，
       两份共存 → 共用同一张欠债凭证。 */
    mutate: (s) => s.replace(/\*\*状态\*\*[：:][^\n]*/, '**状态**：`READY_FOR_REVIEW`（见 `issues.md` #18）')
  },
  {
    name: 'PASS 的结论不许是「有条件通过」',
    file: PASSED,
    mutate: (s) => s.replace(/- 结论：[^\n]*/, '- 结论：有条件通过（条件：补 e2e 断言）'),
    skip: !PASSED,
    skipWhy: '当前没有 PASS 状态的契约——等第一份转 PASS 后自动生效'
  },
  {
    name: '复核对象写一个没登记锚点的历史摘要，不许当通过',
    file: PASSED,
    /* 第八种绕法（2026-11-10）：把「复核对象必须等于当前树」放宽成「可以是历史树」之后，
       随手编一个摘要就可能蒙混过关。现在只在 pass-anchors.md 里登记过的摘要才算数。 */
    mutate: (s) => s.replace(/树摘要\s*`[0-9a-f]{16}`/, '树摘要 `deadbeefdeadbeef`'),
    skip: !PASSED,
    skipWhy: '当前没有 PASS 状态的契约——等第一份转 PASS 后自动生效'
  },
  {
    name: '锚点账本只许追加，改写旧记录要被拦',
    file: '../pass-anchors.md',
    /* 第九种绕法（2026-11-10）：账本既然能「提供出处」，就能被改成另一个出处。
       改标题、改旧锚点都算改写——门禁拿 HEAD 里的那份做前缀比对。 */
    mutate: (s) => s.replace(/^# 历史 PASS 的锚点关系/m, '# 历史锚点关系'),
    skip: !anchorsAtHead,
    skipWhy: '账本还没进过 HEAD——第一版提交后自动生效'
  }
];

const results = [];
const base = runFast();
const baseGreen = base.code === 0;

/* 基线本来是红的，那「改一处之后还是红的」什么都证明不了——
   不能拿一条一直红着的门禁当「拦住绕法」的证据。 */
for (const c of cases) {
  /* 跳过的用例单列成「未覆盖」，不算进「全部被拦」——上一版就是这么虚报成 6 条的。 */
  if (c.skip) { results.push({ name: c.name, ok: true, run: false, info: c.skipWhy }); continue; }
  if (!baseGreen) { results.push({ name: c.name, ok: false, run: true, info: '基线本身不绿，绕法判定不可信——先把基线修绿' }); continue; }
  const p = path.join(DIR, c.file);
  const before = fs.readFileSync(p);
  const text = before.toString('utf8');
  const after = c.mutate(text);
  if (after === text) { results.push({ name: c.name, ok: false, run: true, info: `${c.file} 没被改动，用例写错了` }); continue; }
  let r;
  try {
    fs.writeFileSync(p, after, 'utf8');
    r = runFast();
  } finally {
    fs.writeFileSync(p, before);
  }
  const restored = fs.readFileSync(p).equals(before);
  if (!restored) {
    results.push({ name: c.name, ok: false, run: true, info: `${c.file} 没还原干净！立刻 git checkout 它` });
    continue;
  }
  results.push({
    name: c.name, run: true,
    ok: r.code !== 0,
    info: r.code !== 0 ? '' : `门禁放行了这种绕法（${c.file}）`
  });
}

const failed = results.filter((r) => !r.ok);
const ran = results.filter((r) => r.run);
const skipped = results.filter((r) => !r.run);
for (const r of results) {
  const tag = !r.run ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${r.name}${r.info ? '  · ' + r.info : ''}`);
}
if (!baseGreen) {
  console.log('注意：当前基线本身不绿，上面「拦住」的结论可能来自别的原因，先修基线再跑一遍。');
}
console.log('');
const tail = skipped.length ? `（另 ${skipped.length} 条未覆盖：${skipped.map((r) => r.name).join('、')}）` : '';
console.log(failed.length
  ? `[不通过] ${failed.length}/${ran.length} 种绕法没被拦住`
  : `[通过] ${ran.length} 种已知绕法全部被拦${tail}`);
process.exit(failed.length ? 1 : 0);
