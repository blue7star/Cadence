# Task Contract — TASK-20261112-temp-daytime

> 工作台「今日待办」顶部快速录入条：补一个日期控件，让「建明天的任务」不用绕道日历。

## 元信息

task_id: TASK-20261112-temp-daytime
contract_version: 1
base_revision: 98d0f4f
gate_level: G1
status: PLANNED
owner: Planner
modules: app-ui, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 用户已确认口径，按 A 方案落码：1.「时」= 一个时间点，不是时段。不加 `time_end`，不做 B0/B1。2. 快速录入条加日期控件，默认今天；`start=end=所选日`，保留现有 time。3. 建的是非今天：只 toast 提示「已加到 11 月 13 日」，不跳页。4. 临时任务保持单日，不允许跨多天。5. 视口统一到 1600×1000，与 e2e 一致。6. 日历面板底部那个「+ 在这一天加临时任务」按钮先不要删，判断留不留给结论但别动它——这次只做录入条。补充授权：体验层面的细节自己判断，不必逐项问；判断标准是让人少走一步、少填一个能推出来的字段。
user_problem: 在「今日待办」想建一条明天的任务时，顶部快速录入条把日期写死成今天（`start: TODAY, end: TODAY`），页面上没有选「天」的地方；只能绕到日历页、点那一格、滚到面板底部再点「+ 在这一天加临时任务」，或者先建今天的再进详情改两个日期框。用户原话：「如果我要在这里建明天的任务就会很不顺手，最好是可以选择 天，时，去做」。
out_of_scope: 不加 `time_end`、不做时段语义；不改临时任务「单日」的既有语义；不改任务类型、阶段规则、导出/导入格式；不删（也不改）日历面板底部的「+ 在这一天加临时任务」；不碰 server.js；不碰正在等口径的导入功能。
acceptance_command: node _dev/verify.mjs --full（期望退出码 0）
stop_conditions: 需要改服务端或表结构才能实现；需要放宽既有 e2e 断言；发现同一受保护路径上有其它会话的未提交改动；需要改动临时任务单日语义才能满足需求。

## 目标与范围

- 业务目标与用户可见的成功：
  - 今日待办顶部录入条可以直接选「哪一天」和「几点」，默认仍是今天；
  - 选明天建完，任务就落在明天（`start=end=所选日`），提示写明落在哪天，页面不跳走；
  - 什么都不选、直接回车，行为与现在完全一致（今天）。
- 范围内（in scope）：
  - `public/app.js`：`viewToday()` 的快速录入条加 `#qDate`（默认 `TODAY`）；`#quickForm` 提交时按所选日写 `start/end`；非今天时 toast 写明日期。样式与既有 time 控件一致，三控件在 1600 宽度下不换行。
  - `_dev/e2e.mjs`：补「按所选日期建任务落到那一天」的正向断言，以及「默认今天不变」的回归断言。
  - `specs/modules/app-ui.md`：公开行为补一句「快速录入条可选日期，默认今天」；变更历史加本 task 一行。
  - `README.md`：临时任务那一行补「可指定日期」。
  - `version.js` + `CHANGELOG.md`：用户可见变化，按 semver 递增 Z。
- 范围外：见元信息 `out_of_scope`。
- 已批准的 L0-L2a 决策：
  - 「时」是一个时间点，复用现有 `task.time`，不加新字段；
  - 非今天只提示、不跳页；
  - 临时任务保持单日；
  - 日历底部按钮保留（见交付里的结论），本轮不动。

## 风险与权限

- 风险理由（为什么是 G1 而不是 G0）：动的是创建入口的默认值与落库字段，默认值错了会把任务静默建到错误日期。
- Human 已决策事项：见上节 4 条口径与补充授权。
- Worker 不得自行决定的事项：临时任务是否跨多天、类型定义、阶段规则、导出格式；日历按钮去留（只给结论，不动代码）。
- 允许的工作区与破坏性操作：`public/app.js`、`_dev/e2e.mjs`、`specs/modules/app-ui.md`、`README.md`、`version.js`、`CHANGELOG.md`、`artifacts/runs/TASK-20261112-temp-daytime/`。不得改 `server.js`、`data/`、`.agents/gates/`。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出码 0；`python .agents/gates/gate.py --ci --repo .` 原始输出随交付。
- 集成与反向路径：e2e 断言「选 2026-11-13 建的临时任务，库中 start=end=2026-11-13，且不在今天的清单里」；另一条断言「不改日期直接回车，仍是今天」。
- 文档同步（蓝图 / specs）：`specs/modules/app-ui.md` 公开行为 + 变更历史；`README.md` 临时任务说明。
- 视觉证据：1600×1000 改前/改后截图落 `walkthrough/`，逐条列问题（B11）。
- 安全、数据、迁移与回滚证据：无表结构变更、无数据迁移；回滚为还原 `public/app.js` 一个文件。
