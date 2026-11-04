# 实践台账：ai-native-engineering @ Cadence

> 本文件是 Cadence 对这套方法的**唯一实践台账**（skill 要求 exactly one）。
> 只记「方法在这个项目上跑出了什么教训」，**不复制项目事实**——事实在下面这些指针里。
> 观察不自动等于提案；同类观察累计 ≥2 次才提 proposal，且要独立 verdict + Human 批准。

schema_version: 1
practice_id: PRACTICE-20261104-cadence-gate-and-review
project_id: Cadence
status: EVIDENCE_READY
created_at: 2026-11-04
owner: Planner
prior_practice: PRACTICE-20261103-ai-native-engineering-cadence

## 指向的事实（只写指针）

| 想知道什么 | 去哪看 |
|---|---|
| 开发规矩、G 分级、提交纪律、fail_source 口径 | `AGENTS.md` |
| 模块边界与不变量 | `docs/modules.md` |
| 采纳了什么、拒绝什么、实测数字 | `docs/adoption-log.md` |
| 问题归因（23 条，7 类） | `issues.md` |
| 契约与复核记录 | `docs/contracts/` |
| 复核清单 | `docs/review-checklist.md` |
| 门禁实现与证据 | `_dev/verify.mjs`、`_dev/verify-report.json`、`.githooks/pre-commit` |

## 观察（现象 + 证据位置，不下结论）

1. **门禁会重复它要禁止的错误。** 第一版「契约状态」检查只判「有没有写 `PASS`」，于是
   「永远不写 `PASS`」成了一条合规通道——所有契约停在 `READY_FOR_REVIEW`，门禁全绿。
   这正是它想禁止的「没有证据算 pass」，只是换了一层皮。证据：`issues.md` #17。

2. **「摘要排除文档」和「复核记录绑树」是两条互相拉扯的要求。**
   把 `docs/` 排除出树摘要解决了自指（契约写摘要 → 摘要变），但复核记录本身就在 `docs/contracts/`，
   于是可以在 `--full` 之后任意改写复核记录而不触发重跑。实测：一次 `AGENTS.md` 改动发生在报告落盘 9 秒后，
   摘要仍然匹配。解法不是二选一，而是加一条「复核对象必须等于报告里的摘要」。证据：`_dev/verify.mjs` 的 `contracts()`。

3. **独立复核对单人项目是可行且便宜的，前提是给它一个入口。**
   用独立子代理当 Reviewer，一次 3–5 分钟、只读、只给「契约 + 代码 + 证据报告」，不给实现理由。
   两轮跑出 13 + 10 条问题，其中 3 条是 P1 且是「证据对不上」级别——是实现者自测不可能发现的类型。
   证据：`docs/contracts/2026-11-03-下派自由选择与知情人.md` 第 3 段。

4. **契约的「差异及原因」字段可以被编造，且机器无法发现。**
   因为该字段不要求引用第 1 段原文。实测：第 2 段写「契约原写 X」，而第 1 段根本没有 X，
   两轮门禁 + 一次自测都没发现，是复核逐句对照原文才抓出来的。证据：`issues.md` #18。

5. **`fail_source` 从 4 类扩到 7 类之后，历史问题的归类会变。**
   项目里两条旧问题按旧口径记成 `review_miss`，按新口径应该是 `machine_gate_miss`。
   分类错了，改的对象就错了：前者改注意力，后者改断言。证据：`issues.md` 的「已解决」表。

## 拟议的方法影响（未提案）

按 skill 自己的门槛，下面四条还只是观察，不构成 proposal：

| 候选 | 若成立要改什么 | 还缺什么 |
|---|---|---|
| 「必须有 X」类检查，必须同时定义「X 何时必须发生」 | `GATES.md` 断言写法 | 第二个项目的同类观察 |
| 复核记录的锚点必须绑到**被验的代码摘要**，而不是文件位置 | `templates/verdict.md` | 本条已在 Cadence 验证，需换项目复现 |
| 单人项目的 Reviewer 可用「独立 Agent 上下文」充当，成本可接受 | `references/quality-and-evidence.md` 的 `REVIEW_NOT_AVAILABLE` 兜底 | 需确认这不是 Cadence 特有（模型能力/项目规模） |
| 契约「差异段」应要求引用第 1 段原文片段 | `templates/task.md` | 需验证引用会不会变成新的形式主义 |

## 不晋升的理由

- 全部观察来自同一个项目、同一个执行者，样本量 1。
- 前两条是**工具实现缺陷**，可能只存在于 Cadence 的自建门禁，不代表方法本身。
- 第 3 条依赖「有独立子代理」这个环境条件，不是所有采纳方都有。

## 冲突与成本

- **成本**：一份契约走完「写 → 实现 → 跑 full → 复核 → 改 → 再复核 → 填第 3 段」，比原来多约 20–30 分钟。
  对 G2 值得；对 G0/G1 不值，所以契约仍只在 G2 写。
- **冲突**：`docs/` 排除出摘要让文档改动不需要证据，但「复核记录」也是文档。
  这是**有意接受的缺口**，缓解手段是把复核对象绑到代码摘要（观察 2）。
- **维护成本**：`contracts()` 的正则要跟着模板字段走；模板改字段而门禁不改，检查会静默失效。
  缓解：模板字段名在 `verify.mjs` 里集中成常量，改一处。

## 生命周期

```
OBSERVED (2026-11-03，首次采纳的记录在 ai-skills/practice/)
  -> EVIDENCE_READY (2026-11-04，本轮：2 轮独立复核 + 门禁 6 项 + e2e 103 项)
```

未进入 `PROPOSED`：proposal_id / proposal_version / proposal_digest 均为空。
