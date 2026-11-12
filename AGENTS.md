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
| 手头有哪些没解决的问题、为什么反复返工 | `.agents/issues.md` | 聊天记录 |
| 产品范围、权限、决策记录 | `docs/product-design.html` | — |
| G2 复核看哪几条 | `.agents/review-checklist.md` | — |
| 采纳过什么外部方法、实测效果如何 | `.agents/practice/adoption-log.md` | — |
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

- **G0 文案、间距、颜色微调**：只作为风险标签，**没有轻口径**——`pre-commit` 本来就重跑 e2e，`--fast` 并不更快。所有改动统一跑 `node _dev/verify.mjs --full` 后再提交。
- **G1 单页交互、表单校验**：动手前先写 `task.md`（受理五字段，见第 4 节 M8），改完必须 `--full`（e2e 里要有这条路径的断言）。
- **G2 接口形状、数据表结构与迁移、身份与可见性、日期算法**：动手前先写契约（`.agents/templates/task.md`，见第 4 节三件套）。受保护面以 `.agents/gates/protected.json` 为准，不在这里维护第二份路径清单。
- **G3 数据结构推倒重来**：先动 `version.js` 的 Y 位，写清迁移方式，再改代码。

## 4. 门禁是双轨，缺一不可

| 轨 | 实现 | 管什么 |
|---|---|---|
| 代码门禁 | `_dev/verify.mjs` | 语法、版本一致性、CHANGELOG、契约状态、门禁反例、工作区干净、e2e（**当场跑，不留入库的报告**） |
| 契约门禁 | `.agents/gates/gate.py`（M1-M8） | 契约存在、证据绑定候选（哈希）、模块蓝图同步、版本权威、引用完整、快照封存、受理字段完备 |

**G1-G3 改动走三 agent 闭环**（`ai-native-engineering` 采纳后，取代旧的一页三段契约）：

```
Planner 写 task.md → Worker 实现 + delivery.md → Reviewer 独立写 verdict.md
   → agent_workflow.py 封存候选 + 记 events.jsonl → gate.py --ci 核对 → Human 验收
```

- 契约用 `.agents/templates/` 三件套（task / delivery / verdict），事件流在 `artifacts/runs/<id>/events.jsonl`（哈希链，只追加，禁手改）。
- 旧 `docs/contracts/` 的一页三段自 2026-11-04 起**退役**，已归档到 `.agents/archive/contracts/`（只读留档），新契约不再用。
- `git commit` 信息带 `Task: <task_id>` trailer；pre-commit 跑 `gate.py --fast --staged` 拦「已 add 的受保护路径缺契约」，CI 跑 `gate.py --ci` 拦「没有证据的合并」。
- 树摘要与锚点账本已撤掉（2026-11-11 收口）：`verify.mjs` 不再写 `verify-report.json`、不做 `--recheck`、不认 `pass-anchors.md`。它管「这棵树现在跑不跑得通」（当场跑，凭证就是退出码），`gate.py` 管「流程走完没」，两者管的是两件事。

`gate.py` 三条边界要记牢：`NOT_RUN` 绝不等于 PASS；pre-commit 未建账本时只提示不拦，CI 对 `no_evidence` 退出 1；`--scope` 只能用 `project`。

**M1 的受保护面是项目事实**：路径写在 `.agents/gates/protected.json`（`server.js`、`public/`、`_dev/`、`specs/`、`data/`、模板/门禁/钩子），不再用脚手架默认的 `app/`——那份默认值和本项目代码没有交集，等于没设防。模块归属由蓝图自己声明：`specs/modules/server-api.md` 写 `paths: server.js`，门禁**不再拿文件名当模块名猜**（`server.js` 的 stem 是 `server`，永远匹配不上 `server-api`）。

**M8 受理闸**：触及受保护路径的提交，`task.md` 必须写满五问——`requirement_quote`（用户原话，不改写）、`user_problem`（谁在什么场景卡住）、`out_of_scope`（这次不做什么）、`acceptance_command`（命令 + 期望退出码）、`stop_conditions`（什么情况停）。缺一项或写 `<待填>` 直接 BLOCKED。一句话需求可以开工，但**答不完这五问不许动手**。

门禁自己也要有反例：`python .agents/gates/gate.py --selftest` 用临时仓库证明「改 `server.js` 没契约会被拦」「受理字段缺一项/写占位符会被拦」「模块不拥有该文件会被拦」，并已接进 `verify.mjs`，每次 `--fast`/`--hook` 都跑一遍。

## 5. 提交纪律

- **改完就提交，不要攒。** 一次提交只做一件事。发版单独一个 `release(vX.Y.Z): …`。
- 提交前必须过双轨。**顺序固定**，别倒：

```bash
git add -A                                       # ① 先入索引：验的和要提交的是同一份
node _dev/verify.mjs --full                      # ② 代码门禁：语法 + 版本 + CHANGELOG + 契约状态 + 工作区干净 + e2e
git commit -m "feat(日历): 一句话" -m "Task: TASK-xxxxxxxx"   # ③ pre-commit 当场重跑 ②，并跑 gate.py --fast --staged
python .agents/gates/gate.py --ci --repo .       # ④ 提交后判流程：读 HEAD 这条提交（默认 HEAD~1...HEAD）
```

- ④ 之所以在提交之后：`--ci` 认的是 `Task:` trailer 与提交里的树，提交前它看不到你要提交的东西。`--full` 绿只代表「这棵树跑得通」，不代表流程走完——两者说法不同不是冲突，是先后。
- 新克隆的仓库启用钩子：`git config core.hooksPath .githooks`。**这是唯一「不做就静默失效」的一步。**

## 6. 出问题先归因，再修

`.agents/issues.md` 里每条反馈必须标一个 `fail_source`，不标不修：

判据一句话：**「如果上一层做得完美，这个问题还会漏吗？」**——不会的那一层，就是主因。八类的含义与该改什么，见 `.agents/issues.md`（唯一口径）。

同一个坑第二次出现，说明上一轮改的不是根因。累计两次同类 `fail_source`，改规则而不是改代码。

## 7. 明确不引入的东西

- **T1 单元测试**（暂时）：`public/app.js` 无模块导出，纯函数抽不出来。先按 `specs/modules/` 拆出纯逻辑层，再补单测——顺序反了只会写出一堆测 DOM 的假单测（issues #12）。
- **M9「契约先行」闸（暂缓，不是否决）**：M9 要求契约在 `base_revision` 那个提交里就已存在，能机器证明「没有先写代码后补契约」。代价是每个 G1+ 要两次提交，摩擦一大就容易诱发 `--no-verify`（issues #9）。先看 M1+M8 的实际拦截率，再决定是否加。
- **M7「模板测试引用可收集」**：不接。它只认 `tests/*.py` 与 pytest，本项目用 `_dev/e2e.mjs`；接进来永远「no tests referenced → PASS」，是假覆盖。若要等价能力，应另写「蓝图引用的 e2e 断言标签存在」这条检查，而不是抄 M7。
- **`docs/adr/` 目录暂不建**：真有跨模块取舍时，决策写进 `docs/adr/NNNN-主题.md`（编号 + 背景 + 选项 + 结论 + 代价）。现在没有这类决策，建空目录只是多一份要维护的壳。
