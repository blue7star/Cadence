# AGENTS.md · 改这个仓库之前先读

这是给人和 AI 助手看的**指针与规矩**。只写「去哪找」和「必须怎么做」，不复述业务与工程细节——
同一件事写两遍，早晚会有一遍是错的。

## 1. 事实只有一个归属者

| 想知道什么 | 只看这里 | 不要在这里找 |
|---|---|---|
| 这东西给谁用、怎么用、日历和任务怎么理解 | `README.md` | 工程细节 |
| 目录、接口、数据模型、关键设计、发版流程 | `DEVELOPMENT.md` | 面向使用者的说法 |
| 现在是什么版本、这版改了什么 | `version.js`（`CHANGELOG.md` 由它生成，勿手改） | 别处硬编码版本号 |
| 每个模块管什么、什么不能坏、依赖朝哪边 | `docs/modules.md` | — |
| 手头有哪些没解决的问题、为什么反复返工 | `issues.md` | 聊天记录 |
| 产品范围、权限、决策记录 | `docs/product-design.html` | — |
| 改 G2 之前要写清的契约 | `docs/contracts/` | — |
| G2 复核看哪几条 | `docs/review-checklist.md` | — |
| 采纳过什么外部方法、实测效果如何 | `docs/adoption-log.md` | — |

改行为就改代码 + 上面**对应那一段**。不要新建第二份说明。

## 2. 风险分级

- **G0 文案、间距、颜色微调**：直接改，`node _dev/verify.mjs --fast` 过了就提交。
- **G1 单页交互、表单校验**：改完必须 `--full`（e2e 里要有这条路径的断言）。
- **G2 下面这些，动手前先写契约**（`docs/contracts/`，一页就够）：
  - `server.js` 的接口形状、`/api/sync` 的合并语义
  - 数据表结构与老数据兼容（`data/workbench.db`）
  - 身份与可见性：谁能看谁的、承接前后可见范围
  - 日期算法：常规实例生成、月历 26 日起、逾期判定
- **G3 数据结构推倒重来**：先动 `version.js` 的 Y 位，写清迁移方式，再改代码。

G2/G3 做完，让**没参与实现的人或新开一轮对话**按 `docs/review-checklist.md` 复核一遍再提交。
自测全绿只证明「我以为的路径没坏」，不证明实现正确。

## 3. 提交纪律

- **改完就提交，不要攒。** 2026-11-03 之前 0.4.7–0.4.13 七个版本一直躺在工作区没提交，一次误操作就全没了。
- 一次提交只做一件事。发版单独一个 `release(vX.Y.Z): …`，只含 `version.js` 与 `CHANGELOG.md`。
- 使用者能感知到变化就 bump `version.js` 的 Z 位，然后 `node version.js --write`。
- 提交前必须过闸，**不要用 `git commit --no-verify`**：

```bash
node _dev/verify.mjs --full      # 语法 + 版本 + CHANGELOG 一致 + 服务版本 + e2e
git add -A && git commit -m "feat(日历): 一句话"
```

`pre-commit` 会复核「磁盘上这棵树是否真的跑过 `--full`」：跑过之后又改了任何文件都会被拦。
新克隆的仓库启用一次钩子：

```bash
git config core.hooksPath .githooks
```

## 4. 出问题先归因，再修

`issues.md` 里每条反馈必须标一个 `fail_source`，不标不修：

| 标记 | 含义 | 该改什么 |
|---|---|---|
| `requirement_gap` | 需求没说清，做出来不是他要的 | 先补口径，再改代码 |
| `testcase_gap` | 口径清楚，但用例没覆盖到 | 先补断言，再改代码 |
| `impl_bug` | 口径和用例都对，代码写错了 | 只改实现 |
| `review_miss` | 上面三步都对，复核时漏了 | 补复核清单 |

同一个坑第二次出现，说明上一轮改的不是根因。累计两次同类 `fail_source`，就要改规则而不是改代码。

## 5. 明确不引入的东西

完整账在 `docs/adoption-log.md`，这里只列红线：

- 不建 `specs/`、不建 `.agents/ledger.jsonl`、不用 `artifacts/agent-runs/` 那套哈希快照。
- 不为一次改动写 task / delivery / verdict 三件套——一份契约文件里三段写完。
- 不把 `version.js` 换成 `VERSION` 文件：版本弹窗和 CHANGELOG 是这个产品的功能，项目事实高于方法默认值。
- 不漏跑 e2e 就提交；不过 e2e 也不许改断言来「让它变绿」——先判断是断言写错了还是代码错了。
