'use strict';
/* 本地门禁：提交前那道真正会拦人的闸。
 *
 * 2026-11-11 收口：这里只做「当场验证」，不再产出任何可被手改的凭证。
 * 之前有三套东西都在回答「这棵树验过没有」——入库的 verify-report.json、--recheck 复算、
 * pass-anchors.md 锚点账本；结果是谁都能改报告，门禁反而要不断加校验层去追。
 * 现在只有一条：提交时当场跑语法 + 契约状态 + e2e，跑不过就不许提交。
 *
 *   node _dev/verify.mjs --fast   静态检查（秒级，改一行就跑得动）
 *   node _dev/verify.mjs --full   静态检查 + e2e（提交前跑这个；也要工作区干净）
 *   node _dev/verify.mjs --hook   pre-commit 调用：当场跑静态检查 + e2e
 *
 * 退出码：0 通过；1 不通过（pre-commit 会据此拦下提交）。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const MODE = process.argv[2] || '--fast';
const FULL = MODE === '--full' || MODE === '--hook';

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
   - PASS 另外要：复核方式、结论「通过」（「有条件通过」不算）、发现的问题有编号或「无」、
     以及**绑定一个归档提交号**——git 提交本身不可变，这就是最可靠的锚；同一份契约必须写明
     「仅对原树有效，未在现行树复核」，门禁只验那个提交在库里存在，不假装它验过现在的树；
   - 一个编号只能挂一份契约，PASS 之后也一样——否则它就从欠债凭证变成通用豁免券。
   机器只能证明「有人写下过一条指向某个提交的复核记录」，证明不了复核真的发生了——那部分仍归人。 */
function contracts() {
  const dir = path.join(ROOT, '.agents', 'archive', 'contracts');
  if (!fs.existsSync(dir)) return check('契约状态与复核记录', false, '找不到 .agents/archive/contracts/');

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

    /* ── PASS：交付、复核记录、归档提交三样都要 ── */
    const way = val(seg3, '复核方式');
    const obj = val(seg3, '复核对象');
    const found = val(seg3, '发现的问题');
    const holes = [];
    if (!hasDelivered) holes.push('第 2 段（交付）是空的——PASS 的契约必须有交付记录');
    /* 模板写的是「新开一轮对话」，门禁原先只认「新开的对话」——按模板填的 PASS 会被误拦。
       这类「模板与门禁对不上」的错，机器只会报成「复核方式不合格」，人看了只会去改文档。 */
    if (!/^(新开(的对话|一轮对话)|独立的子代理|他人)/.test(way)) holes.push('复核方式（要写明是谁、哪种方式）');
    /* 复核对象只能绑提交号：git 提交不可变，改不动，也不用复算摘要。
       以前绑 16 位树摘要，树一变就得回去改历史结论，或者靠锚点账本「借」一个出处——
       两套账最后都变成了「想办法让门禁变绿」。现在只认「归档提交 `xxxxxxx`」。 */
    const arc = (obj.match(/(?:归档提交|commit)\s*`?([0-9a-f]{7,40})`?/) || [])[1];
    if (!arc) holes.push('复核对象（必须写 `归档提交 `xxxxxxx``）');
    else {
      const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${arc}^{commit}`],
        { cwd: ROOT, encoding: 'utf8' });
      if (exists.status !== 0) holes.push(`归档提交 ${arc} 在库里不存在`);
      if (!/仅对原树有效/.test(s)) holes.push('必须注明「仅对原树有效，未在现行树复核」');
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

  return check(`契约状态 ${files.length} 份（交付即须复核，PASS 绑归档提交）`, bad.length === 0,
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
    env: { ...process.env, CADENCE_NO_SELFTEST: '1' }
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

/* ── 4. 工作区 ───────────────────────────────────────────── */
/* 只验「已经全部 add 的树」：人跑的是这份，提交的也得是这份。
   不再算摘要——没有报告要跟索引对账，唯一要证明的就是「你验的和你提交的是同一份」。 */
function worktreeClean() {
  const list = (args) => execFileSync('git', args, { cwd: ROOT }).toString()
    .split('\n').filter(Boolean);
  const bad = [...new Set([
    ...list(['diff', '--name-only']),
    ...list(['ls-files', '--others', '--exclude-standard'])
  ])];
  return check('工作区干净（只验已入索引的树）', bad.length === 0,
    bad.length
      ? `未暂存/未跟踪 ${bad.length} 个：${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' …' : ''} → git add 后重跑`
      : '索引即待提交的树');
}

/* ── 4. 服务与 e2e ───────────────────────────────────────── */
/* e2e 从 2026-11-10 起跑在**测试库副本**上，由 --full 自己起实例、跑完收摊。
   之前它连 8788 那个真实库：会「全员密码重置成工号」、删掉临时员工、造上百条夹具任务，
   跑一次本地演示数据就花一次，而且必须人工先双击启动脚本。现在：
   - 每次用 VACUUM INTO 从 data/workbench.db 取一份一致快照到 _dev/.test-db/；
   - server.js 认 CADENCE_DB，实例指到副本上；
   - 跑完杀掉实例、删副本。真实库一个字节都不动。 */
const TEST_DIR = path.join(ROOT, '_dev', '.test-db');
const TEST_DB = path.join(TEST_DIR, 'workbench.db');
const TEST_PORT = Number(process.env.CADENCE_TEST_PORT || 8799);
const TEST_BASE = `http://localhost:${TEST_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshTestDb() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const real = path.join(ROOT, 'data', 'workbench.db');
  if (!fs.existsSync(real)) return true; /* 新克隆还没有真实库：让实例自己建演示库 */
  const { DatabaseSync } = await import('node:sqlite');
  const src = new DatabaseSync(real);
  /* VACUUM INTO 拿到的是一致快照；直接复制文件会漏掉还在 WAL 里、没 checkpoint 的写入 */
  src.exec(`VACUUM INTO '${TEST_DB.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  src.close();
  /* 清掉副本里的管理账号：让测试实例每次都走「首次启动随机生成并打印一次」的真实路径，
     e2e 才能验 mustChange。真实库里的那一行不动。 */
  const copy = new DatabaseSync(TEST_DB);
  try { copy.prepare('DELETE FROM admin_auth').run(); } catch { /* 老库还没这张表 */ }
  copy.close();
  return true;
}

function startInstance(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CADENCE_DB: TEST_DB },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  /* 管理账号的一次性初始密码只出现在启动日志里；e2e 要用它走首次登录流程。
     所以这里必须接住 stdout，而不是 ignore。 */
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { out += b.toString(); });
  child.log = () => out;
  return child;
}

async function waitUp(base, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(base + '/api/version');
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return null;
}

function portBusy(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch { /* 已断 */ } res(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

async function testInstance() {
  /* 端口上要是已经有人（上一轮没退干净的实例），新实例会绑不上而退出，
     waitUp 却会连上那个旧进程——它读的可能是真实库，等于绕过这层隔离。 */
  if (await portBusy(TEST_PORT)) {
    check('测试端口空闲', false, `${TEST_PORT} 已被占用：先关掉残留实例，或用 CADENCE_TEST_PORT 换一个端口`);
    return null;
  }
  try { await freshTestDb(); } catch (e) {
    check('测试库副本可用', false, e.message);
    return null;
  }
  const child = startInstance(TEST_PORT);
  const j = await waitUp(TEST_BASE);
  const want = createRequire(import.meta.url)(path.join(ROOT, 'version.js')).SEMVER;
  if (!j) {
    try { child.kill(); } catch { /* 已经退了 */ }
    check('测试实例能起来（独立测试库，真实库不动）', false, `连不上 ${TEST_BASE}`);
    return null;
  }
  check('测试实例在跑（独立测试库，真实库不动）', j.semver === want,
    j.semver === want ? `v${want} · ${TEST_DB}` : `实例是 v${j.semver}，代码是 v${want}`);
  if (j.semver !== want) { try { child.kill(); } catch { /* 已退 */ } return null; }
  /* 首次启动才打印：从「已创建管理账号 admin……」后面那一行取出一次性密码 */
  const m = /初始密码[^\n]*\n\s*(\S+)/.exec(child.log());
  const adminPwd = m ? m[1] : '';
  check('测试实例打印了 admin 一次性初始密码', !!adminPwd,
    adminPwd ? '（已交给 e2e 做首次登录）' : '启动日志里没抓到，检查 ensureAdmin 是否被触发');
  let cur = child;
  return {
    base: TEST_BASE,
    adminPwd,
    restart: async () => {
      /* 真重启：换一个进程读同一份测试库。改密是写库，重启之后不该变——这条只有真重启才测得出来。 */
      try { cur.kill(); } catch { /* 已退 */ }
      await sleep(300);
      const c = startInstance(TEST_PORT);
      const up = await waitUp(TEST_BASE);
      if (!up) { try { c.kill(); } catch { /* 已退 */ } return null; }
      cur = c;
      return c;
    },
    /* 收摊要杀「当前」那个进程：restart 之后原来那个已经不在了 */
    stop: () => { try { cur.kill(); } catch { /* 已退 */ } }
  };
}

/* 重启幂等：改密 → 杀进程 → 新进程登录。密码只该在库里，不该在内存里。
   admin 的密码由 e2e 改成 Admin-E2e-2026；员工的用 1004（e2e 结束时它被重置回工号）。 */
async function restartPwdCheck(test) {
  const login = (no, password) => fetch(test.base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ no, password })
  }).then((x) => x.json()).catch(() => ({}));

  const again = await test.restart();
  if (!again) {
    check('改密 → 真重启 → 新密码仍然可用', false, '重启后实例起不来');
    return false;
  }
  const adminNew = await login('admin', 'Admin-E2e-2026');
  const adminOld = test.adminPwd ? await login('admin', test.adminPwd) : { ok: false };
  const empReset = await login('1004', '1004');
  const a = check('改密 → 真重启 → 管理账号新密码可登录、一次性初始密码失效',
    adminNew.ok === true && adminOld.ok === false,
    `新 ${adminNew.ok ? 'ok' : '不行'} / 旧 ${adminOld.ok ? '还能用（不对）' : '已失效'}`);
  const b = check('重置过的员工密码在重启后仍然有效', empReset.ok === true, JSON.stringify(empReset).slice(0, 120));
  return a && b;
}

function e2e(base, adminPwd) {
  /* e2e 会直接改库做夹具；把测试库路径显式传给它，它自己也会拒绝在真实库上跑。
     admin 的一次性初始密码也从这里传给 e2e，它才能走完「首次登录 → 强制改密」。 */
  const r = spawnSync(process.execPath, [path.join(ROOT, '_dev', 'e2e.mjs'), base],
    { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, CADENCE_DB: TEST_DB, CADENCE_TEST_ADMIN_PWD: adminPwd || '' } });
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

  if (FULL) {
    /* 提交时当场跑，不再先看有没有「验过的报告」。
       少了报告，也就没有了「手改报告骗过 pre-commit」这条缝。 */
    ok = worktreeClean() && ok;
    /* 自己起一个读测试库副本的实例：不依赖谁先手工把 8788 点起来，
       也不会把真实库里的人的密码改成工号、把人造任务留在真实数据里。 */
    const test = await testInstance();
    if (!test) ok = false;
    else {
      try {
        ok = e2e(test.base, test.adminPwd) && ok;
        ok = await restartPwdCheck(test) && ok;
      } finally {
        test.stop();
        await sleep(300);
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (ok) {
    console.log(`[通过] ${checks.length} 项全绿`);
    if (MODE === '--full') {
      console.log('提交：git add -A → git commit（pre-commit 会当场重跑同一套验证）');
      console.log('提交后：python .agents/gates/gate.py --ci --repo . 确认整体门禁（读 HEAD，提交信息要带 Task: trailer）');
    } else if (MODE === '--fast') console.log('--fast 不跑 e2e：只适用于「改一行先看一眼」，不能当提交依据');
    process.exit(0);
  }
  console.log(`[不通过] ${failed.length}/${checks.length} 项有问题，提交会被拦下：`);
  for (const f of failed) console.log(`  - ${f.name}${f.info ? '：' + f.info : ''}`);
  process.exit(1);
}

main();
