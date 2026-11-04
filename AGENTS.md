# AGENTS.md · 改这个仓库之前先读

这是给人和 AI 助手看的**指针与规矩**。只写「去哪找」和「必须怎么做」，不复述业务与工程细节——
同一件事写两遍，早晚会有一遍是错的。

## 1. 事实只有一个归属者

| 想知道什么 | 只看这里 | 不要在这里找 |
|---|---|---|
| 这东西给谁用、怎么用、日历和任务怎么理解 | `README.md` | 工程细节 |
| 目录、部署、发版流程、代码约定 | `DEVELOPMENT.md` | 面向使用者的说法 |
| **需求语义、能力边界、公开契约不变量** | `.agents/SPEC.md` | 实现细节（接口/表结构细节在 DEVELOPMENT.md §4/§5） |
| **模块职责、公开行为、不变量、依赖边界** | `specs/modules/`（`README.md` 索引 + 各蓝图） | 实现细节 |
| 现在是什么版本、这版改了什么 | `version.js`（`CHANGELOG.md` 由它生成，勿手改） | 别处硬编码版本号 |
| 手头有哪些没解决的问题、为什么反复返工 | `issues.md` | 聊天记录 |
| 产品范围、权限、决策记录 | `docs/product-design.html` | — |
| G2 复核看哪几条 | `docs/review-checklist.md` | — |
| 采纳过什么外部方法、实测效果如何 | `docs/adoption-log.md` | — |
| 方法层观察与晋升提案 | `.agents/practice/ai-native-engineering.md` | 项目事实 |

改行为就改代码 + 上面**对应那一段**。不要新建第二份说明。

## 2. 角色与权限（谁能不能做什么）

| 角色 | 拥有 | 不得拥有 |
|---|---|---|
| Human（lan） | 业务目标、语义、关键设计选择、风险接受、最终验收 | 被迫复核每个实现细节 |
| Planner（AI） | 需求澄清、L0-L2a、任务契约、G 分级、失败路由、与 Human 沟通 | 生产实现、篡改 Reviewer 判定、静默接受风险 |
| Worker（AI） | L2b-L3 实现、正式自测、候选交付 | 扩大范围、宣判 PASS/验收/生效 |
| Reviewer（AI，独立上下文） | 对精确候选的独立语义与证据评审、签署 verdict、硬阻断 | 修改候选、降低契约标准、业务验收 |
| Machine（门禁） | 确定性检查、身份/摘要校验、仅追加事件校验 | 语义判定、业务判断、风险偏好 |

**裁决必须独立**：判 PASS 的上下文不得是实现者的上下文；自己的测试不能自证验收。
`REVIEW_NOT_AVAILABLE`（拿不到独立上下文）时 G2/G3 停下，G1 只能由 Human 显式接受点名风险继续——**自评审不得改名成独立评审**。

## 3. 风险分级

- **G0 文案、间距、颜色微调**：直接改，`node _dev/verify.mjs --fast` 过了就提交。
- **G1 单页交互、表单校验**：改完必须 `--full`（e2e 里要有这条路径的断言）。
- **G2 下面这些，动手前先写契约**（`.agents/templates/task.md`，见第 4 节三件套）：
  - `server.js` 的接口形状、`/api/sync` 的合并语义
  - 数据表结构与老数据兼容（`data/workbench.db`）
  - 身份与可见性：谁能看谁的、承接前后可见范围
  - 日期算法：常规实例生成、月历 26 日起、逾期判定
- **G3 数据结构推倒重来**：先动 `version.js` 的 Y 位，写清迁移方式，再改代码。

契约面下限（碰了就不是 G0）：① 对外接口；② 数据模型与迁移；③ 权限与鉴权；④ 阈值/枚举/口径常量；⑤ 依赖大版本升级。

## 4. 门禁是双轨，缺一不可

| 轨 | 实现 | 管什么 |
|---|---|---|
| 代码门禁 | `_dev/verify.mjs` | 语法、版本一致性、CHANGELOG、服务版本、e2e、树摘要（含未提交/未跟踪文件） |
| 契约门禁 | `.agents/gates/gate.py`（M1-M6） | 契约存在、证据绑定候选（哈希）、模块蓝图同步、版本权威、引用完整、快照封存 |

**G1-G3 改动走三 agent 闭环**（`ai-native-engineering` 采纳后，取代旧的一页三段契约）：

```
Planner 写 task.md → Worker 实现 + delivery.md → Reviewer 独立写 verdict.md
   → agent_workflow.py 封存候选 + 记 events.jsonl → gate.py --ci 核对 → Human 验收
```

- 契约用 `.agents/templates/` 三件套（task / delivery / verdict），事件流在 `artifacts/runs/<id>/events.jsonl`（哈希链，只追加，禁手改）。
- 旧 `docs/contracts/` 的一页三段自 2026-11-04 起**退役**（历史保留），新契约不再用。
- `git commit` 信息带 `Task: <task_id>` trailer；pre-commit 跑 `gate.py --fast --staged` 拦「已 add 的受保护路径缺契约」，CI 跑 `gate.py --ci` 拦「没有证据的合并」。
- 树摘要仍分三把尺子（代码 / 证据 / 文档），见第 5 节——它管「代码验过没」，gate.py 管「流程走完没」，两者管的是两件事。

`gate.py` 三条边界要记牢：`NOT_RUN` 绝不等于 PASS；pre-commit 未建账本时只提示不拦，CI 对 `no_evidence` 退出 1；`--scope` 只能用 `project`。

## 5. 提交纪律

- **改完就提交，不要攒。** 一次提交只做一件事。发版单独一个 `release(vX.Y.Z): …`。
- 提交前必须过双轨：

```bash
node _dev/verify.mjs --full                      # 代码门禁：语法 + 版本 + CHANGELOG + 服务版本 + e2e
python .agents/gates/gate.py --ci --repo .       # 契约门禁：M1-M6（G1 以上改动）
git add -A && git commit -m "feat(日历): 一句话"
```

- 树摘要分三把尺子：代码摘要 `digest`（js/html/bat/库脚本）、证据摘要 `evidenceDigest`（契约/issue/蓝图/AGENTS/practice/SPEC）、文档摘要 `docsDigest`（其余文档）。前两把参与判定，别混。
- `--full` 不通过时不覆盖已有绿证据；拦「失败后又改代码」靠摘要对不上，不靠销毁证据。
- 新克隆的仓库启用钩子：`git config core.hooksPath .githooks`。**这是唯一「不做就静默失效」的一步。**

## 6. 出问题先归因，再修

`issues.md` 里每条反馈必须标一个 `fail_source`，不标不修：

判据一句话：**「如果上一层做得完美，这个问题还会漏吗？」**——不会的那一层，就是主因。

| 标记 | 含义 | 该改什么 |
|---|---|---|
| `requirement_gap` | 需求没说清 | 先补口径，再改代码 |
| `contract_gap` | 契约缺语义，实现者无从对齐 | 补契约结构/边界/对账语义 |
| `testcase_gap` | 口径清楚但用例没覆盖 | 先补断言，再改代码 |
| `impl_bug` | 口径和用例都对，代码写错 | 只改实现 |
| `machine_gate_miss` | 机器门禁该拦没拦 | 改门禁规则或检查项 |
| `review_miss` | 上面都做了，复核没发现 | 补复核清单 |
| `walkthrough_gap` | 端到端走查缺维度 | 补走查清单 |

同一个坑第二次出现，说明上一轮改的不是根因。累计两次同类 `fail_source`，改规则而不是改代码。

## 7. 明确不引入的东西

- **T1 单元测试**（暂时）：`public/app.js` 无模块导出，纯函数抽不出来。先按 `specs/modules/` 拆出纯逻辑层，再补单测——顺序反了只会写出一堆测 DOM 的假单测（issues #12）。
- **改 `version.js` 为 `VERSION` 文件**：版本弹窗和 CHANGELOG 是产品功能；`gate.py` 的 M4 已支持 `version_authority: version.js`，无需换文件。
- 其余红线见 `docs/adoption-log.md`。
