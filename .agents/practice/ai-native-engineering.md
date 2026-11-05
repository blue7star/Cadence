# 实践台账：ai-native-engineering @ Cadence

> Cadence 对这套方法的**唯一活台账**。只记「方法在这个项目上跑出了什么教训」，不复制项目事实。
> 观察不自动等于提案；同类观察累计 ≥2 次才提 proposal，且要独立 verdict + Human 批准。

schema_version: 1
practice_id: PRACTICE-20261104-cadence-gate-and-review
project_id: Cadence
task_id: TASK-20261104-cadence-review-loop
status: EVIDENCE_READY
created_at: 2026-11-04
updated_at: 2026-11-04
recorder: Planner（AI 助手）
owner: Planner
project_fact_owner: 由下表各指针文件各自持有；本文件只持方法层观察，不持项目事实
prior_practice: PRACTICE-20261103-ai-native-engineering-cadence

## 与旧台账的关系（exactly one）

`D:\ai_project\ai-skills\practice\ai-native-engineering-cadence.md` 是**上一轮采纳的历史观察**，
写在方法仓库里，`project_id` 同样是 Cadence。那份自本文件创建起**转为只读**，不再更新；
Cadence 的方法层观察只写在这里。两者不是并行真相：那份是 2026-11-03 的快照，本文件是活台账。

> 为什么没有物理搬迁：那份还带着「对 skill 提出的 5 条修正」和 skill 方的复验结果，
> 属于方法仓库自己的证据链。搬走会让它断链。这里明确声明边界，比复制一份更难漂移。

## 指向的事实（只写指针）

| 想知道什么 | 去哪看 |
|---|---|
| 开发规矩、G 分级、提交纪律、fail_source 口径 | `AGENTS.md` |
| 需求语义与不变量 | `.agents/SPEC.md` |
| 模块边界与不变量 | `specs/modules/` |
| 采纳了什么、拒绝什么、实测数字 | `.agents/practice/adoption-log.md` |
| 问题归因与分类口径 | `.agents/issues.md` |
| 新契约模板与账本 | `.agents/templates/`、`artifacts/runs/` |
| 复核清单 | `.agents/review-checklist.md` |
| 门禁实现与证据 | `_dev/verify.mjs`、`_dev/verify-report.json`、`.githooks/pre-commit` |

## 观察（现象 + 根因假设，不下结论）

### 1. 门禁会重复它要禁止的错误

第一版「契约状态」检查只判「有没有写 `PASS`」。结果是一条合规通道被打开：
**永远不写 `PASS`**，全部停在 `READY_FOR_REVIEW`，门禁全绿。
这正是它想禁止的「没有证据算 pass」，只是换了一层皮。

根因假设：任何以「某事已发生」为条件的检查，如果没有定义「X 何时必须发生」，
就会退化成「没人自称违规」。检查的对象是**声明**，不是**事实**。

### 2. 「摘要排除文档」与「复核记录必须绑树」是两条互相拉扯的要求

把 `docs/` 排除出树摘要解决了自指（契约写摘要 → 摘要变），但复核记录本身就在 `docs/contracts/`，
于是可以在 `--full` 之后任意改写复核记录而不触发重跑。

根因假设：**「不改变运行行为的文件」和「不需要证据的文件」不是同一个集合。**
前者可以排除出代码摘要，后者不能排除出「证据是否新鲜」的判断。需要第二把尺子（evidenceDigest）。

### 3. 独立复核对单人项目可行且便宜，前提是给它一个入口

用独立子代理当 Reviewer：只读、只给「契约 + 代码 + 证据报告」、不给实现理由。
三轮里两轮打回，抓出的问题里有相当一部分是实现者自测永远发现不了的类型
（例如「台账把未修的记成已解决」）。

根因假设：实现者检查的是「我改的地方对不对」，复核检查的是「契约说的和你做的对不对得上」。
后者需要不同的输入集，换个上下文比换个问题有效。

### 4. 契约的「差异及原因」字段可以被编造，且机器无法发现

该字段不要求引用第 1 段原文。实测写过一条「契约原写 X」，而第 1 段根本没有 X；
两轮门禁 + 一次自测都没发现，是复核逐句对照原文才抓出来的。

根因假设：**自述类字段没有对账物，就等于没有约束。** 要约束它，必须让它可以被机器或人对照。

### 5. `fail_source` 分类变细之后，历史问题的归类会变

项目里有两条旧问题按 4 类口径记成 `review_miss`，按 7 类口径应该是 `machine_gate_miss`。
分类错了，改的对象就错了：前者改注意力，后者改断言。

根因假设：分类粒度决定修复对象。粒度不够时，不同根因会被折叠成同一个标签，修法必然打偏。

### 6. 完全落实：三个实测盲区被 skill 3.0.0 修复

2026-11-03 是「选择性采纳」——只取方法层（事实单一归属、契约、独立复核、fail_source），
**拒绝工具层**（`gate.py`、`agent_workflow.py`、`scaffold_project.py` 一律不用，见 `.agents/practice/adoption-log.md` 第 3/4 节）。
2026-11-04 转「完全落实」：工具层也接入，`.agents/gates/gate.py` 成为双轨门禁里的契约门禁。

当时拒绝 `gate.py` 的三个实测盲区，全部由 skill 3.0.0 修复，本项目已逐条对上：

| 当时的盲区 | 当时的实测现象 | 现在的修复 |
|---|---|---|
| ① 只比 `HEAD~1...HEAD` | M1/M3 看不见工作区与暂存区，门禁接错入口 | 新增 `--staged` 判 `git diff --cached`（索引区），pre-commit 拦「已 add 的受保护路径缺契约」 |
| ② 0 PASS 算通过 | `check_m2` 在 `checked==0` 时返回 `0 PASS events bound` 且 ok=true | `NOT_RUN`/`no_evidence` 一律退出 1，与「`NOT_RUN != PASS`」自洽 |
| ③ 只认 `VERSION` 文件 | 18 个版本的记录被读成 `0 version declaration(s)` | M4 支持 `version_authority: <path>`，本项目声明 `version_authority: version.js` 后 M4 PASS |

根因假设：这三条不是「用错了」而是「工具层没长全」——第一版只覆盖了「有账本、有契约的仓库」这条主线，
没覆盖「还没建账本 / 用自定义版本源 / 工作区有改动」这些真实分支。反馈把分支补上，skill 才从
「只能演示」变成「能真跑」。这是「反馈推动 skill 演进」的直接证据，留在账本里。

## 证据

| 项 | 位置 |
|---|---|
| evidence_uri | `_dev/verify-report.json`（门禁 6 项的原始输出与树摘要） |
| evidence_digest | DEEPDIGEST（每次 `--full` 后同步更新，内容为 `verify-report.json` 的 sha256 前 16 位） |
| reproduction_conditions | Node 22、本机 Chromium（`_dev/e2e.mjs` 顶部路径）、服务跑在 8788、`node _dev/verify.mjs --full` |
| 复核记录 | `.agents/archive/contracts/2026-11-03-下派自由选择与知情人.md` 第 3 段 |
| 问题归因 | `.agents/issues.md` |

## 拟议的方法影响（未提案）

按 skill 自己的门槛，下面四条还只是观察，不构成 proposal：

| 候选 | 若成立要改什么 | 还缺什么 |
|---|---|---|
| 「必须有 X」类断言，必须同时定义「X 何时必须发生」 | `GATES.md` 的断言写法 | 第二个项目的同类观察 |
| 复核记录的锚点绑到「被验的代码摘要」，而不是文件位置 | `templates/verdict.md` | 已在 Cadence 验证，需换项目复现 |
| 单人项目的 Reviewer 可用「独立 Agent 上下文」充当 | `references/quality-and-evidence.md` 的 `REVIEW_NOT_AVAILABLE` 兜底 | 需确认不是 Cadence 特有（模型能力 / 项目规模） |
| 契约「差异段」应要求引用第 1 段原文片段 | `templates/task.md` | 需验证引用会不会变成新的形式主义 |

## 不晋升的理由

- 全部观察来自同一个项目、同一个执行者，样本量 1。
- 前两条是**工具实现缺陷**，只存在于 Cadence 的自建门禁，不代表方法本身。
- 第 3 条依赖「有独立子代理」这个环境条件，不是所有采纳方都有。

## 冲突与成本

- **成本**：一份契约走完「写 → 实现 → 跑 full → 复核 → 改 → 再复核 → 填第 3 段」，比原来多约 20–30 分钟。
  对 G2 值得；对 G0/G1 不值，所以契约仍只在 G2 写。
- **冲突**：`docs/` 排除出代码摘要，但「复核记录」也是文档。缓解手段是 evidenceDigest + 复核对象绑代码摘要。
- **维护成本**：`contracts()` 的字段正则跟着模板走；模板改字段而门禁不改，检查会静默失效。
  当前没有抽成常量，改模板时要同步搜 `verify.mjs` 里的字段名。

## 生命周期

```
OBSERVED (2026-11-03，上一轮记录在 ai-skills/practice/，已转只读)
  -> EVIDENCE_READY (2026-11-04，本轮：三轮独立复核 + 门禁 6 项 + e2e 全绿)
```

未进入 `PROPOSED`：proposal_id / proposal_version / proposal_digest 均为空。
