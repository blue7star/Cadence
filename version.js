'use strict';
/**
 * Cadence 版本号与更新内容的唯一定义点。
 *
 * ── 版本规则（语义化 vX.Y.Z）────────────────────────────────
 *   X  不兼容的大改（数据结构/使用方式推倒重来）
 *   Y  新功能成批上线（一期试点、一个大能力）
 *   Z  修复与优化（用户看得见的变化一律 bump Z）
 * 只要使用者能感知到变化，就必须 bump 版本号——否则更新提示无从触发，
 * 使用者永远不知道东西变了。改完结构或文案，同步更新本文件 CHANGELOG。
 *
 * ── 更新内容怎么写 ──────────────────────────────────────────
 * 面向使用者的人话：写「他现在能做什么 / 哪里不再出问题」，
 * 不写内部模块名、表名、接口名、commit、代码细节。
 * 分组只能用 GROUPS 里的四类，每条一句话，能读出不看第二遍。
 *
 * ── 其他位置一律引用本文件 ──────────────────────────────────
 * 服务端 / 前端需要版本号时通过接口取（/api/version），禁止别处硬编码。
 * git 不可用时降级为纯 SEMVER，绝不抛异常——版本展示不能影响服务可用。
 *
 * ── 命令 ────────────────────────────────────────────────────
 *   node version.js            打印完整版本串
 *   node version.js --check    发布前自检（当前版本有登记、结构合法）
 *   node version.js --write    由 CHANGELOG 生成仓库根目录 CHANGELOG.md
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 人工维护的唯一版本号。发版只改这一处。 */
const SEMVER = '0.3.0';

/** 分组白名单：写别的分组自检会报错，避免同类内容一会儿一个说法。 */
const GROUPS = ['新增能力', '体验增强', '口径变更', '问题修复'];

/**
 * 全部版本的更新内容。
 * 键 = 版本号；新增版本在**最前面**加一块，不要动历史版本的文字。
 */
const CHANGELOG = {
  '0.3.0': {
    date: '2026-11-02',
    title: '花名册可整批导入，离职可停用',
    items: [
      {
        group: '新增能力',
        lines: [
          '花名册支持整批导入：工号、姓名、岗位、部门、上级工号填成一张表，导入后请大家刷新页面就能用新账号，不用重启',
          '导入前自动检查：工号写重了、姓名空着、上级工号不存在都会一条条指出来，有问题就一条都不写，不会导一半',
          '离职的人可以停用：停用后此人登录不了、也不再出现在下属名单里，但之前做过的任务和日历记录都留着；返聘可以重新启用',
        ],
      },
    ],
  },
  '0.2.0': {
    date: '2026-11-02',
    title: '停用与删除分清楚，版本更新可见',
    items: [
      {
        group: '问题修复',
        lines: [
          '常规工作点「停用」后，日历里不会再冒出新安排：今天及以前的原样保留，明天以后还没做的自动撤掉，再点「启用」就恢复',
          '「删除」才是彻底删除：这条常规连同它排过的全部安排一起清掉，删了不能恢复',
          '下属看板在周末和节假日自动显示下一个工作日，不再整页「今日无节点」',
          '日常规只按工作日排，不再把周末也排进去（此前会多出约三成用不上的安排）',
        ],
      },
      {
        group: '新增能力',
        lines: [
          '新版本上线后，打开工作台会自动弹出本次更新内容，点「知道了」后不再打扰',
          '顶栏常驻版本号，随时点开可看历次更新记录',
        ],
      },
    ],
  },
  '0.1.0': {
    date: '2026-11-02',
    title: '一期试点版上线',
    items: [
      {
        group: '新增能力',
        lines: [
          '四类工作在同一个台子上管：任务制定（下发与进展）、常规工作、专项工作、临时任务，状态统一为待开展 / 进行中 / 已完成 / 暂缓',
          '常规工作按日、周、月设固定节点，一个周期可以挂多个节点，跨月的周期（如 28 号到次月 15 号）照常排',
          '日历待办支持把任务拖到别的日子改期，自动绕开周末和法定节假日',
          '任务承接台：上级下发的任务落到下属这里，确认承接后自动记下来源，上级能看到进展',
          '分类自己管：两级分类，改名字、加子类都不用来找开发',
          '下属看板：一眼看清下级今天该做的常规工作和完成情况',
        ],
      },
      {
        group: '体验增强',
        lines: [
          '多个人共用一个服务，谁改了东西，别人 7 秒内就能看到',
          '双击一个文件就启动，不用敲命令；关掉窗口就是停止',
        ],
      },
      {
        group: '口径变更',
        lines: [
          '登录用工号 + 姓名，不设密码（一期试点，仅限内网使用）',
          '数据存在这台机器的本地数据库里，不上传外部服务，也不进企业微信',
        ],
      },
    ],
  },
};

/** 当前版本的更新内容；没登记返回 null（前端据此静默，不弹空窗）。 */
function getChangelog() {
  return CHANGELOG[SEMVER] || null;
}

/** 全部已登记版本，按版本号数值倒序（0.10.0 必须排在 0.9.0 前面）。 */
function getChangelogHistory() {
  const key = v => {
    const parts = String(v).split('.').map(n => parseInt(n, 10));
    return parts.length === 3 && parts.every(n => Number.isFinite(n)) ? parts : [0, 0, 0];
  };
  return Object.keys(CHANGELOG)
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    })
    .map(v => ({ version: v, date: CHANGELOG[v].date, title: CHANGELOG[v].title, items: CHANGELOG[v].items }));
}

/** 项目根 = 本文件所在目录（git 命令的工作目录）。 */
const ROOT = __dirname;
const GIT_TIMEOUT_MS = 5000;

let _fullVersion = null;
/**
 * 完整版本串 `{SEMVER}+{提交数}.{短hash}`。
 * 元数据由 git 派生，每次提交自动变化，不用人工维护。
 * 进程内只算一次；git 不可用（没装 / 不是仓库 / 超时）时降级为纯 SEMVER。
 */
function getFullVersion() {
  if (_fullVersion) return _fullVersion;
  try {
    const run = args =>
      execFileSync('git', args, {
        cwd: ROOT,
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const count = run(['rev-list', '--count', 'HEAD']);
    const hash = run(['rev-parse', '--short', 'HEAD']);
    _fullVersion = count && hash ? `${SEMVER}+${count}.${hash}` : SEMVER;
  } catch (e) {
    _fullVersion = SEMVER; // 版本展示是非关键路径，绝不因 git 让服务起不来
  }
  return _fullVersion;
}

/** 自检：返回问题数组，空数组即通过。 */
function check() {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(SEMVER)) problems.push(`SEMVER 不是 X.Y.Z 形式：${SEMVER}`);

  const entry = getChangelog();
  if (!entry) problems.push(`当前版本 ${SEMVER} 没有登记更新内容（使用者将看不到更新提示）`);

  for (const [ver, e] of Object.entries(CHANGELOG)) {
    if (!/^\d+\.\d+\.\d+$/.test(ver)) problems.push(`${ver}：版本号不是 X.Y.Z 形式`);
    if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) problems.push(`${ver}：date 缺失或不是 YYYY-MM-DD`);
    if (!e.title || !String(e.title).trim()) problems.push(`${ver}：title 为空`);
    if (!Array.isArray(e.items) || !e.items.length) { problems.push(`${ver}：items 为空`); continue; }
    for (const it of e.items) {
      if (!GROUPS.includes(it.group)) problems.push(`${ver}：分组「${it.group}」不在白名单（${GROUPS.join(' / ')}）`);
      if (!Array.isArray(it.lines) || !it.lines.length) problems.push(`${ver}：分组「${it.group}」没有条目`);
      else if (it.lines.some(l => !String(l).trim())) problems.push(`${ver}：分组「${it.group}」存在空条目`);
    }
  }
  return problems;
}

/** 由 CHANGELOG 生成 Markdown。生成物，不手改。 */
function toMarkdown() {
  const out = [
    '# 更新记录 · Cadence',
    '',
    '> 本文件由 `version.js` 自动生成，**不要手改**——改了 version.js 后执行：',
    '> `node version.js --write`',
    '',
    '> 面向使用者的说明，按版本倒序。版本规则：新功能成批上线升 Y，修复与优化升 Z，不兼容的大改升 X。',
    '> 更新提示的运行时数据同样来自 `version.js`，此处只是同一份内容的人读版本，不存在第二份真相。',
    '',
  ];
  for (const v of getChangelogHistory()) {
    out.push(`## v${v.version} · ${v.date}`, '', `**${v.title}**`, '');
    for (const it of v.items) {
      out.push(`### ${it.group}`, '');
      for (const line of it.lines) out.push(`- ${line}`);
      out.push('');
    }
  }
  // 只写 SEMVER：完整串含提交数，会随每次提交变化，写进来生成物就没法稳定比对
  out.push('---', '', `当前版本：**v${SEMVER}**（完整串见顶栏或 \`node version.js\`）`, '');
  return out.join('\n');
}

module.exports = { SEMVER, GROUPS, CHANGELOG, getChangelog, getChangelogHistory, getFullVersion, check, toMarkdown, ROOT };

if (require.main === module) {
  const arg = process.argv[2] || '';
  if (arg === '--check') {
    const problems = check();
    if (problems.length) {
      console.error(`[版本自检] 发现 ${problems.length} 处问题：`);
      problems.forEach(p => console.error('  - ' + p));
      process.exit(1);
    }
    console.log(`[版本自检] 通过：当前 v${SEMVER}，已登记 ${Object.keys(CHANGELOG).length} 个版本。`);
  } else if (arg === '--write') {
    const file = path.join(ROOT, 'CHANGELOG.md');
    fs.writeFileSync(file, toMarkdown(), 'utf8');
    console.log(`已生成 ${file}（当前 v${SEMVER}）`);
  } else if (arg === '--json') {
    console.log(JSON.stringify({ semver: SEMVER, version: getFullVersion(), changelog: getChangelog(), versions: getChangelogHistory() }, null, 2));
  } else {
    console.log(getFullVersion());
  }
}
