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
const FAST_REPORT = path.join(ROOT, '_dev', 'verify-report-fast.json');
const FAIL_REPORT = path.join(ROOT, '_dev', 'verify-report-last-fail.json');
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

   前几版的漏洞，都是复核时被抓出来的，记在这里免得再走一遍：
   ① 只判「有没有写 PASS」→ 永远不写 PASS 就成了合规通道；
   ② 正文里先放一行「示例：**状态**：PLANNED」→ 真正的 PASS 躲过检查；
   ③ `_` 开头或子目录 → 整体跳过；④ 一份契约都没有 → 判绿（把门拆了就算通过）；
   ⑤ 第 2 段按加粗标签判 → 标签少两个星号，检查完全失效；
   ⑥ 段落用 `##\s*3[\.\s]` 定位 → 标题写成 `## 3 复核`（少一个点）整段跳过；
   ⑦ 第 2 段判成「未交付」就免复核 → 把交付内容删空，反而最省事。

   现在的口径是「状态与交付必须自洽」：
   - 状态行全文件唯一、值在枚举里；
   - 段落按标题**文字**定位（含「交付」「复核」），各恰好一段——逗号、空格、少个点都不影响；
   - 交付段与模板重合的部分不算交付（照抄占位符等于没写），剩下的字数说了算；
   - 交付段空着，状态却是 READY_FOR_REVIEW / PASS → 红（说可以复核了，可什么都没交）；
   - 交付段有内容，状态却是 PLANNED / IN_PROGRESS → 红（做完了不往前走）；
   - 交付有内容、停在 READY_FOR_REVIEW → 必须在 issues.md「未解决」表里挂编号（欠债登记，不是豁免）；
   - PASS 另外要：一次 --full 的绿证据 + 复核记录绑在**它复核的那棵树**上（当前树，或在 `.agents/archive/pass-anchors.md` 里登记过的历史树）+ 结论就是「通过」（「有条件通过」不算）；
   - 一个编号只能挂一份契约，PASS 之后也一样——否则它就从欠债凭证变成通用豁免券。
   机器只能证明「有人写下过一条指向这版代码的复核记录」，证明不了复核真的发生了——那部分仍归人。 */
function contracts() {
  const dir = path.join(ROOT, '.agents', 'archive', 'contracts');
  if (!fs.existsSync(dir)) return check('契约状态与复核记录', false, '找不到 .agents/archive/contracts/');
  const rep = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : null;
  const live = rep && rep.full && rep.ok ? rep.digest : null;
  /* 独立锚点记录：每份历史 PASS 当初复核的是哪棵树、之后的树怎么变的。
     它不改契约原文，也不代替复核结论；只在「摘要不是当前树」时提供出处。 */
  const anchorFile = path.join(ROOT, '.agents', 'archive', 'pass-anchors.md');
  const anchors = () => (fs.existsSync(anchorFile)
    ? fs.readFileSync(anchorFile, 'utf8').split('\n') : []);
  /* 账本只许追加：锚点写进去之后不能再改。
     拿 HEAD 里的那份做前缀比对——改一个旧锚点，等于把历史证据挪个位置，
     而门禁只认账本里的原始锚点，改了就成「自己给自己发豁免券」。
     第一版在 HEAD 里还不存在时（或不在 git 仓库里）不设限。 */
  const anchorsAppendOnly = () => {
    if (!fs.existsSync(anchorFile)) return true;
    let head;
    try {
      head = execFileSync('git', ['show', 'HEAD:.agents/archive/pass-anchors.md'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return true; }
    const now = fs.readFileSync(anchorFile, 'utf8').replace(/\r\n/g, '\n');
    return now.startsWith(head.replace(/\r\n/g, '\n'));
  };

  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.toLowerCase().endsWith('.md') && e.name !== '_template.md') files.push(path.join(d, e.name));
    }
  })(dir);

  /* 一份契约都没有 = G2 的入口被删掉了。这时候判绿，等于「把门拆了就算通过」。 */
  if (!files.length) return check('契约状态', false, '.agents/archive/contracts 下一份契约都没有（模板不算）');

  const V = ['PLANNED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'PASS'];
  const unresolved = fs.existsSync(path.join(ROOT, '.agents', 'issues.md'))
    ? fs.readFileSync(path.join(ROOT, '.agents', 'issues.md'), 'utf8').split('## 已解决')[0] : '';
  const bad = [];
  if (!anchorsAppendOnly()) bad.push('pass-anchors.md 改写了已提交的锚点（账本只许追加）');
  const nos = (t) => [...t.matchAll(/[#＃](\d+)/g)].map((x) => x[1]);
  const debts = {}; /* 欠债编号 → 挂了它的契约名，用来发现「一张豁免券被几份契约共用」 */

  /* 段落锚定：**认编号，不认标题里的字**。
     上一版用 `includes('交付')` 找段落，于是「## 1. 任务（交付前必读）」这种标题
     把第 1 段当成了交付段，真正的交付段随便改成「## 2. 记录」、内容删空，门禁照样绿——
     这是复核找出来的第七种绕法。现在先按 `## 2` / `## 3` 的编号认；
     只有整份文件根本没编号时才退回按关键字认（老契约可能写成 `## 交付`）。 */
  const headsOf = (text) => [...text.matchAll(/^##[ \t]+([^\n]*)$/gm)].map((m) => {
    const n = /^(\d+)(?![0-9])/.exec(m[1]);
    return { text: m[1], num: n ? Number(n[1]) : null, start: m.index, bodyStart: m.index + m[0].length };
  });
  const findSeg = (heads, num, kw) => {
    const byNum = heads.filter((h) => h.num === num);
    return byNum.length ? byNum : heads.filter((h) => h.text.includes(kw));
  };

  /* 交付段「写了没有」怎么量：和模板重合的部分不算。
     照抄模板占位符的契约，看起来有几百字，其实一个字都没写。
     做法是拿模板第 2 段做参照，算「这棵树里找不到的字符数」——
     比硬编码一份字段名列表可靠：模板改字段，这把尺子自动跟着变。 */
  const tplFile = path.join(dir, '_template.md');
  const tplSeg2 = (() => {
    if (!fs.existsSync(tplFile)) return '';
    const t = fs.readFileSync(tplFile, 'utf8');
    const th = headsOf(t);
    const a = findSeg(th, 2, '交付')[0];
    const b = findSeg(th, 3, '复核')[0];
    return a && b && a.start < b.start ? t.slice(a.bodyStart, b.start) : '';
  })();
  /* 归一化：只留中日韩文字和字母数字。标点、下划线占位符、行首符号全部丢掉。 */
  const norm = (t) => t.replace(/<!--[\s\S]*?-->/g, '').replace(/待填/g, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const tplNorm = norm(tplSeg2);
  const W = 6;
  const freshChars = (seg) => {
    const n = norm(seg);
    if (!tplNorm) return n.length;
    const covered = new Uint8Array(n.length);
    for (let i = 0; i + W <= n.length; i++) {
      if (tplNorm.includes(n.slice(i, i + W))) for (let k = 0; k < W; k++) covered[i + k] = 1;
    }
    let c = 0;
    for (let i = 0; i < n.length; i++) if (!covered[i]) c++;
    return c;
  };

  for (const p of files) {
    const name = path.relative(dir, p).split(path.sep).join('/');
    const s = fs.readFileSync(p, 'utf8');
    const own = new Set(); /* 这份契约名下挂的编号 */

    const stM = [...s.matchAll(/\*\*状态\*\*[：:]\s*`?([A-Z_]+)`?/g)];
    if (stM.length !== 1) { bad.push(`${name}：状态行出现 ${stM.length} 次（必须恰好 1 次）`); continue; }
    const st = stM[0][1];
    if (!V.includes(st)) { bad.push(`${name}：状态「${st}」不在 ${V.join('/')} 里`); continue; }
    /* 状态行后面常跟一行说明（「—— 待补，见 issues.md #17」），欠债编号要看这一小段 */
    const stBlock = s.slice(stM[0].index, stM[0].index + 300);

    const hs = headsOf(s);
    const h2 = findSeg(hs, 2, '交付');
    const h3 = findSeg(hs, 3, '复核');
    if (h3.length !== 1) {
      bad.push(`${name}：第 3 段（复核）标题有 ${h3.length} 个（必须恰好 1 个）——删掉它等于跳过复核`);
      continue;
    }
    if (h2.length !== 1) {
      bad.push(`${name}：第 2 段（交付）标题有 ${h2.length} 个（必须恰好 1 个）——没法知道交付写在哪`);
      continue;
    }
    if (h2[0].start > h3[0].start) { bad.push(`${name}：第 2 段排在第 3 段后面`); continue; }

    const seg2 = s.slice(h2[0].bodyStart, h3[0].start);
    const seg3 = s.slice(h3[0].bodyStart);
    /* 阈值 60：太短等于给「实际改了：见代码」这种半句话开口子。 */
    const hasDelivered = freshChars(seg2) >= 60;

    const val = (seg, k) => {
      const m = seg.match(new RegExp(`-\\s*[^\\n]*${k}[^：:\\n]*[：:]\\s*([^\\n]*)`));
      return m ? m[1].trim() : '';
    };
    const verdict = val(seg3, '结论');

    if (st !== 'PASS') {
      /* 复核写完了却不转状态，两处会打架：人看到「通过」，机器看到「没做完」。 */
      if (/^通过/.test(verdict)) {
        bad.push(`${name}：第 3 段写了「通过」，状态却是 ${st}——复核完就该转 PASS`);
        continue;
      }
      if (!hasDelivered) {
        /* 状态说「可以复核了」，交付段却只有模板占位符。这一段是空的，就没什么可复核的。 */
        if (st !== 'PLANNED' && st !== 'IN_PROGRESS') {
          bad.push(`${name}：状态 ${st}，第 2 段（交付）却是空的——没写交付，就不算交出去了`);
        }
        for (const n of nos(stBlock)) own.add(n);
      } else if (st === 'PLANNED' || st === 'IN_PROGRESS') {
        bad.push(`${name}：状态还是 ${st}，第 2 段却写了交付——交付了就该进 READY_FOR_REVIEW`);
        continue;
      } else {
        const debt = /issues\.md[\s\S]{0,200}?[#＃](\d+)/.exec(stBlock);
        if (!debt) {
          bad.push(`${name}：已交付但状态是 ${st}，却没说清欠在哪——状态行要写「见 issues.md #编号」`);
        } else if (!new RegExp(`\\|\\s*${debt[1]}\\s*\\|`).test(unresolved)) {
          bad.push(`${name}：挂的 issues.md #${debt[1]} 不在「未解决」表里——那就不叫欠债`);
        }
        /* 第 2 段「遗留问题」点到的编号，也算挂在它名下 */
        const legacy = seg2.split('\n').filter((l) => l.includes('遗留')).join('\n');
        for (const n of [...nos(stBlock), ...nos(legacy)]) own.add(n);
      }
      for (const n of own) (debts[n] = debts[n] || []).push(name);
      continue;
    }

    /* ── PASS：交付、证据、复核记录三样都要，而且要对得上 ── */
    if (!live) { bad.push(`${name}：标了 PASS，但没有任何一次 --full 的绿证据`); continue; }
    const way = val(seg3, '复核方式');
    const obj = val(seg3, '复核对象');
    const found = val(seg3, '发现的问题');
    const holes = [];
    if (!hasDelivered) holes.push('第 2 段（交付）是空的——PASS 的契约必须有交付记录');
    /* 模板写的是「新开一轮对话」，门禁原先只认「新开的对话」——按模板填的 PASS 会被误拦。
       这类「模板与门禁对不上」的错，机器只会报成「复核方式不合格」，人看了只会去改文档。 */
    if (!/^(新开(的对话|一轮对话)|独立的子代理|他人)/.test(way)) holes.push('复核方式（要写明是谁、哪种方式）');
    /* PASS 绑的是「它复核时那棵树」，不是「现在这棵树」。
       旧写法要求所有历史 PASS 契约都包含当前摘要——每改一次代码就得回去改历史结论，
       等于把复核证据改成「看起来还绿」。现在：摘要等于当前树 → 通过；
       摘要不是当前树 → 必须在 pass-anchors.md 里有一条同时写着这份契约名和这个摘要的锚点。
       摘要写错、锚点缺失、表里查不到，照样红。 */
    const dg = (obj.match(/树摘要\s*`?([0-9a-f]{16})`?/) || [])[1];
    if (!dg) holes.push('复核对象（必须写 16 位树摘要）');
    else if (dg !== live && !anchors().some((line) => line.includes(name) && line.includes(dg))) {
      holes.push(`复核对象 ${dg} 既不是当前这棵树（${live}），也没有在 .agents/archive/pass-anchors.md 里登记锚点`);
    }
    /* PASS 的结论只能是「通过」。「有条件通过」的意思是条件还没做完，那就是没通过。 */
    if (!/^通过/.test(verdict) || /有条件/.test(verdict)) {
      holes.push('结论（PASS 只能是「通过」；「有条件通过」说明条件还没做完）');
    }
    if (!/(^无$|#[0-9]+)/.test(found)) holes.push('发现的问题（写编号，或「无」）');
    if (holes.length) bad.push(`${name}：状态 PASS 但 ${holes.join('、')}`);
    /* PASS 也要登记编号：转成 PASS 之后编号就被「释放」的话，下一份契约能接着用它当豁免券 */
    for (const n of [...nos(found), ...nos(stBlock)]) own.add(n);
    for (const n of own) (debts[n] = debts[n] || []).push(name);
  }

  /* 一个编号只能挂一份契约。三份契约共用 #19 的时候，它就不是欠债登记，是通用豁免券——
     谁会去修一条「同时欠三份契约」的债？ */
  for (const [no, names] of Object.entries(debts)) {
    if (names.length > 1) bad.push(`issues.md #${no} 被 ${names.length} 份契约共用（${names.join('、')}）——欠债要一条对一份`);
  }

  return check(`契约状态 ${files.length} 份（交付即须复核，复核绑树摘要）`, bad.length === 0,
    bad.length ? bad.join('；') : '');
}

/* ── 3.5 门禁的反面用例 ──────────────────────────────────── */
/* 上面那段 `contracts()` 改到第四版，每一版都是「复核指出一种绕法 → 补一条判断」。
   补完从来没人证明它真拦得住，下一次改别的规则又可能把门开回去。
   `_dev/gate-selftest.mjs` 把历次被指出的绕法固化成用例（改一份契约 → 跑 --fast → 期望非 0 → 还原）。
   门禁自己也需要一份「坏的例子」，否则它只是在宣称自己有效。 */
function gateSelftest() {
  if (process.env.CADENCE_NO_SELFTEST) return true; /* 反面用例自己会调 --fast，别递归 */
  const file = path.join(ROOT, '_dev', 'gate-selftest.mjs');
  if (!fs.existsSync(file)) return check('门禁反面用例', false, '找不到 _dev/gate-selftest.mjs——没人证明它拦得住绕法');
  const r = spawnSync(process.execPath, [file], {
    encoding: 'utf8', maxBuffer: 1 << 24,
    env: { ...process.env, CADENCE_NO_SELFTEST: '1', CADENCE_NO_REPORT: '1' }
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const okFast = check('门禁反面用例（已知绕法全部被拦）', r.status === 0,
    r.status === 0 ? out.split('\n').filter((l) => l.startsWith('[通过]'))[0] || ''
      : (fails.length ? fails.join(' | ') : out.split('\n').slice(-3).join(' ')));
  return okFast && gateContractSelftest();
}

/* 契约门禁自己的反例：M1（受保护面/模块归属）与 M8（受理五字段）各要证明它红过。
   只宣称「会拦」不算数，得有命令跑给你看。 */
function gateContractSelftest() {
  const gate = path.join(ROOT, '.agents', 'gates', 'gate.py');
  if (!fs.existsSync(gate)) return check('契约门禁反面用例', false, '找不到 .agents/gates/gate.py');
  const python = process.env.CADENCE_PYTHON || 'python';
  const g = spawnSync(python, [gate, '--selftest'], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const out = ((g.stdout || '') + (g.stderr || '')).trim();
  if (g.error) {
    return check('契约门禁反面用例（M1/M8 会拦）', false,
      `跑不了 ${python}（${g.error.code || g.error.message}）——缺它等于这道闸不存在`);
  }
  const fails = out.split('\n').filter((l) => l.startsWith('[失败]'));
  return check('契约门禁反面用例（M1/M8 会拦）', g.status === 0,
    g.status === 0 ? (out.split('\n').find((l) => l.startsWith('通过：')) || '')
      : (fails.length ? fails.join(' | ') : out.split('\n').slice(-3).join(' ')));
}

/* ── 4. 这棵树的摘要 ─────────────────────────────────────── */
/* 覆盖「已跟踪 + 已暂存 + 未跟踪但没被忽略」的文件，也就是 git add -A 之后要进库的那批。
   工作区脏不脏不影响算摘要——脏状态正是要被验的对象。

   但摘要只算「会改变运行行为」的文件，文档排除在外。两个原因，都是实测出来的：
   1) 契约要把摘要写进自己，摘要又算了契约 → 写完就变，这个锚点永远对不上（自指）；
   2) 纯文档改动不改变任何可观察行为，为它重跑 90 秒 e2e 是浪费，
      而 AGENTS.md 第 2 节本来就允许 G0 只跑 --fast。
   文档单独算一个 docsDigest，只作记录，不参与放行判断。 */
/* `artifacts/` 是证据，不是运行行为：任务契约、交付、verdict、事件账本都在这儿。
   把它算进代码摘要会让「写一条证据」就改一次代码摘要——刚验完的树立刻变成另一棵树，
   归档契约的复核锚点永远落后一代，下次 `--full` 必红，最后只能 `--no-verify`（issues #64）。
   所以它和 `.agents/` 一样：不进代码摘要，进证据摘要，让 `--hook` 仍能看见它变了。 */
const DOC_ONLY = /^(docs\/|\.agents\/|artifacts\/|CHANGELOG\.md$|README\.md$|DEVELOPMENT\.md$|AGENTS\.md$|issues\.md$)/;
/* 「证据与规矩」类文件：不改变运行行为，但改变了「能不能信这棵树」。
   它们也排除在代码摘要之外，所以单独算一个 evidenceDigest，让 --hook 也能看见——
   否则改完契约第 3 段、改完 AGENTS.md 的 G 分级，门禁一律认为「这棵树没变过」。 */
/* 2026-11-05 文档归位后，契约/issue/复核/采纳记录全部收进 `.agents/`，一条前缀覆盖。 */
const EVIDENCE = [/^\.agents\//, /^artifacts\//, /^AGENTS\.md$/];

function treeDigest() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
  const files = out.split('\0').filter(Boolean).sort();
  const h = crypto.createHash('sha256');
  const dh = crypto.createHash('sha256');
  const eh = crypto.createHash('sha256');
  const each = {};
  let codeFiles = 0;
  let evidenceFiles = 0;
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, f)); } catch { continue; } /* 已删除、待提交 */
    each[f] = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
    const isDoc = DOC_ONLY.test(f);
    const hh = isDoc ? dh : h;
    if (!isDoc) codeFiles++;
    if (EVIDENCE.some((re) => re.test(f))) {
      evidenceFiles++;
      eh.update(f); eh.update('\0'); eh.update(String(buf.length)); eh.update('\0'); eh.update(buf);
    }
    hh.update(f); hh.update('\0'); hh.update(String(buf.length)); hh.update('\0'); hh.update(buf);
  }
  return {
    digest: h.digest('hex').slice(0, 16), docsDigest: dh.digest('hex').slice(0, 16),
    evidenceDigest: eh.digest('hex').slice(0, 16),
    files: Object.keys(each).length, codeFiles, evidenceFiles, each
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
  let ok = syntax() && version() && contracts() && gateSelftest();

  if (MODE === '--full') {
    const up = await served();
    /* 服务没起或版本旧，e2e 验的是旧代码，跑了也没意义 */
    ok = up ? e2e() && ok : false;
  }

  const tree = treeDigest();

  if (MODE === '--hook') {
    /* 静态问题先报，报完再看有没有完整的验证记录 */
    const rep = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : null;
    const fast = fs.existsSync(FAST_REPORT) ? JSON.parse(fs.readFileSync(FAST_REPORT, 'utf8')) : null;
    const codeSame = !!rep && rep.digest === tree.digest;
    const evSame = !!rep && rep.evidenceDigest === tree.evidenceDigest;
    /* 契约/台账/规矩改了但代码没动：跑一次 0.5 秒的 --fast 就够，不用陪跑 90 秒 e2e */
    const fastCovers = !!fast && fast.ok === true && fast.digest === tree.digest
      && fast.evidenceDigest === tree.evidenceDigest;
    const bound = !!rep && rep.full === true && rep.ok === true && codeSame && (evSame || fastCovers);
    let why = '';
    if (bound) why = `${rep.digest} · ${rep.at.slice(11, 19)} 验过` + (evSame ? '' : '（文档改动由 --fast 覆盖）');
    else if (!rep) why = '从来没有验证记录 → 先跑 node _dev/verify.mjs --full';
    else if (!rep.full) why = '这棵树只跑过 --fast，缺 e2e → 重跑 --full';
    else if (!rep.ok) why = '上次完整校验没通过 → 修完重跑 --full';
    else if (!codeSame) {
      const d = diffPaths(rep.each, tree.each);
      why = `验过之后又改了 ${d.length} 个文件（${d.slice(0, 5).join(', ')}${d.length > 5 ? ' …' : ''}）→ 重跑 --full`;
    } else if (!evSame) why = '契约 / 台账 / 规矩改过了 → 跑 node _dev/verify.mjs --fast';
    else why = `${rep.digest} 的记录不完整 → 重跑 --full`;
    check('这棵树跑过完整校验', bound, why);
    ok = ok && bound;
  }

  /* 证据只许被 --full 更新。--fast 写到另一个文件：
     它是「改一行先看一眼」的秒级自检，写进正式证据就会把上次的绿记录覆盖成 full=false。
     失败的 --full 也不写正式证据——一次 e2e 抖动不该把唯一的绿记录弄丢；
     靠 digest 对不上来拦「失败后又改代码」，而不是靠销毁证据。
     `CADENCE_NO_REPORT`：门禁反面用例会拿改过的契约反复跑 --fast，那是探针，不是证据，
     让它写报告等于用假状态覆盖真记录。 */
  if (process.env.CADENCE_NO_REPORT) { /* 探针模式：只判绿红，不写任何证据 */ } else if (MODE === '--full') {
    const report = {
      at: new Date().toISOString(), mode: MODE, head: headRev(),
      digest: tree.digest, docsDigest: tree.docsDigest, evidenceDigest: tree.evidenceDigest,
      files: tree.files, codeFiles: tree.codeFiles, evidenceFiles: tree.evidenceFiles,
      each: tree.each, full: true, ok, checks
    };
    if (ok) fs.writeFileSync(REPORT, JSON.stringify(report, null, 1), 'utf8');
    else {
      fs.writeFileSync(FAIL_REPORT, JSON.stringify(report, null, 1), 'utf8');
      if (fs.existsSync(REPORT)) console.log('（这次没通过，正式的绿证据保留不动，见 verify-report-last-fail.json）');
    }
  } else if (MODE === '--fast') {
    fs.writeFileSync(FAST_REPORT, JSON.stringify({
      at: new Date().toISOString(), mode: MODE, ok,
      digest: tree.digest, evidenceDigest: tree.evidenceDigest
    }, null, 1), 'utf8');
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (ok) {
    console.log(`[通过] ${checks.length} 项全绿 · 树 ${tree.digest}`
      + `（${tree.codeFiles} 个代码文件 / ${tree.files - tree.codeFiles} 个文档）`);
    if (MODE === '--full') console.log('可以提交：git add -A && git commit -m "…"');
    else if (MODE === '--fast') console.log('--fast 不跑 e2e：只适用于「代码没动、只改了文档/契约」的提交');
    process.exit(0);
  }
  console.log(`[不通过] ${failed.length}/${checks.length} 项有问题，提交会被拦下：`);
  for (const f of failed) console.log(`  - ${f.name}${f.info ? '：' + f.info : ''}`);
  process.exit(1);
}

main();
