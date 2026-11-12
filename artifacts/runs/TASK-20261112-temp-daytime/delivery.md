# Delivery — TASK-20261112-temp-daytime

## 改了什么

- `public/app.js`
  - 今日待办快速录入条新增 `#qDate`（`type=date`，宽 132px，默认 `TODAY`），排在标题与时间点之间；三个控件同一行，1600 宽度下不换行。
  - 提交处理器按所选日期落库：`start=end=所选日`，`time` 仍取原时间框；日期被清空时按今天兜底。
  - 提示分两种：今天仍是「已加入今日待办」，非今天为「已加到 11月13日」（`fmt(day)`），不跳页。
- `_dev/e2e.mjs`：新增 3 条断言——选明天建的任务落库 `start=end=明天` 且类型是 `temp`；提示写明落到哪一天、且不再说「今日待办」；明天的任务不进今日 `.tlist`，日期框提交后回到默认今天。
- `specs/modules/app-ui.md`：公开行为补「快速录入条可选日期（默认今天）」；变更历史加一行。
- `specs/modules/tooling.md` / `specs/modules/version.md`：变更历史各加一行（路径归属与版本 bump）。
- `README.md`：临时任务一行补「可指定哪天、几点（默认今天）」。
- `version.js`：0.9.2 → 0.9.3（用户可见变化，按 INV-4 bump Z），CHANGELOG 新增 0.9.3 条目；`CHANGELOG.md` 由 `node version.js --write` 生成。

## 没做什么

- 没加 `time_end`，没做时段语义；「时」仍是一个时间点，复用既有 `task.time`。
- 没改临时任务「单日」语义，没改类型定义、阶段规则、导出/导入格式。
- 没动 `server.js`、表结构与数据。
- 没动日历面板底部的「+ 在这一天加临时任务」。

## 日历底部按钮：保留（结论，未改代码）

保留。理由：改动后它不再是「建未来任务的唯一入口」，但仍是**在日历上下文里一步打开完整表单**的入口（能填达成标准、分类、优先级），删掉会把正在看日历的人赶去另一个页面重选日期。它的问题（在当天清单下方、需要滚动才看得见）是可见性问题，不是重复问题；本轮范围只在录入条，未处理。

## 验证

- `node _dev/verify.mjs --full`：12/13 通过；**唯一红项是「工作区干净」**，列出的是另一个会话的 `.agents/issues.md` 与 `.agents/archive/PLAN-20261112-企管导入.md`（按用户指示未暂存、未回滚、未改动）。e2e **218 项全 PASS**，含本轮新增 3 条。
- `python .agents/gates/gate.py --ci --repo .`：提交后运行，原始输出见本轮汇报（未写入本文件，避免提交后再次弄脏工作区）。

## 自审记录（1600×1000）

- 改前：`walkthrough/01-before-today-1600.png`
- 改后（默认今天）：`walkthrough/02-after-today-1600.png`
- 改后（选明天 + 填标题/时间）：`walkthrough/03-after-tomorrow-1600.png`
- 逐条问题与处置：见 `walkthrough/self-review.md`。

## 未自签

未写 `verdict.md`、未标记 PASS；独立复核留给 Reviewer。
