# 模块边界

> 回答一个问题：**这部分代码归谁管、什么不能坏、坏了先看哪。**
> 只写边界和不变量，不写实现细节——实现看代码，业务口径看 `README.md`，设计约定看 `DEVELOPMENT.md`。

## 依赖方向（只能朝下，不能回头）

```
public/index.html ──样式────┐
public/app.js ──────────────┼── HTTP ──→ server.js ──→ version.js
public/changelog.js ────────┘              │
                                           └──→ data/workbench.db（node:sqlite）
```

- 前端**不 require 任何服务端文件**，只走 `/api/*`。
- `version.js` 是版本唯一源：服务端 require 它，前端通过 `/api/version` 取，`public/changelog.js` 只做展示，**不得自带版本号字面量**。
- 服务端**不读前端代码**，只按文件名发静态文件。

## 模块清单

| 模块 | 管什么（OWNED） | 不变量（坏了会怎样） |
|---|---|---|
| `version.js` | 版本号、每版更新内容、人读 `CHANGELOG.md` 生成、自检 | `SEMVER` 是唯一版本源且必须是 `CHANGELOG` 里最新的键；分组只能用四类；`CHANGELOG.md` 必须与 `--write` 输出逐字一致（`verify.mjs` 会比对） |
| `server.js` 数据层 | 建表、`emp`、`task`、`rule`、`cat`、操作日志 | 表结构变更必须兼容已有 `data/workbench.db`；加字段给默认值，不改已有列含义 |
| `server.js` 实例引擎 | `ruleSteps` / `cyclesBetween` / `ensureInstances` / `maintain`：常规规则 → 当期实例 | **幂等**：同一 owner、同一规则、同一周期只能有一条实例；重复跑 `maintain` 不产生新行 |
| `server.js` 同步 | `/api/sync`：前端提交整棵树，服务端按 id 增改删 | 只接受本人有权的任务；**后写覆盖**（已知边界）；返回新 `rev`，前端据此判断是否要重取 |
| `server.js` 可见性 | `stateFor()`：本人 + 下属 + 已承接 | 上级只在**下属承接后**可见；可见范围是只读，写操作永远回落到本人校验 |
| `public/app.js` 状态层 | 拉取 → 本地 `S` → 快照 diff → `save()` | 不直接写库；任何会改数据的交互最终都走 `save()` → `/api/sync` |
| `public/app.js` 日历 | `occOn` / `calChipHTML` / `chipLate` / `sortOcc` / `calCells` | 日历与清单**同源**（同一个 `occOn`）；月历固定上月 26 日起、排到当月最后一天；已完成不算逾期 |
| `public/index.html` | 全部样式与三套视觉通道 | 来源=底色字色、状态=左侧色条+短文字、逾期=红框；三者互不覆盖；图例必须与卡片同形 |
| `import-emp.js` | CSV → `emp`，含干跑与校验 | 不带 `--apply` 绝不写库；重复工号只更新不新增 |
| `_dev/e2e.mjs` | 端到端断言清单（T3） | 每条用户可见行为都要有对应断言；**不许为了让测试变绿而放宽断言** |
| `_dev/verify.mjs` | 提交门禁：语法、版本、CHANGELOG、服务版本、e2e、树摘要 | 摘要必须覆盖未提交/未跟踪文件；`--full` 才算数 |

## 目前最疼的一块

`public/app.js` 2158 行、无模块导出：日期计算、逾期判定、状态与节点对齐这些**纯逻辑**只能靠 e2e 验证，
改一处要等 90 秒才知道对错，而且失败信息只能看到「界面不对」，看不到「哪个函数算错了」。

这是 `issues.md` 里 #12 的来源，也是唯一值得拆的模块：把这些纯函数抽成可 `import` 的一层，
就能补 T1 单测。**拆之前别加新逻辑**——先把现有行为用 e2e 锁死再搬。

## 改哪个模块，顺手要看哪里

| 改动 | 一并检查 |
|---|---|
| 加接口字段 | `stateFor()`、`applySync()`、`public/app.js` 的 `S` 结构、e2e 里读该字段的断言 |
| 改日期算法 | `ruleSteps`、`stepPlanDate`、`calCells`、`chipLate`，以及 `_dev` 里对应的用例 |
| 改视觉 | `index.html` 的 `.chip.cal` 与图例同时改；跑 e2e 的 `日历来源底色/状态色条/逾期红框` 三条断言 |
| 改可见性 | `stateFor()`、`subsOf()`、详情页只读分支、`切换下属身份` 用例 |
