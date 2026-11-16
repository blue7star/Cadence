# 基线 — TASK-20261116-year-routine（年常规）

日期：2026-11-16　基线提交：`f7a1b46`（与 `origin/main` 一致）

## 现状（改前）

- `rule.cycle` 只有 `day | week | month`：`upsertRule` 没有任何白名单，未知值会静默落进月分支（[server.js:921-938](file:///d:/ai_project/ai_work/Cadence/server.js#L921-L938)）。
- 周期切分 `cyclesBetween` 只有日/周/月三分支（[server.js:231-253](file:///d:/ai_project/ai_work/Cadence/server.js#L231-L253)）；`stepPlanDate` 月分支用 `s.mo`（本月/次月偏移）+ `s.day`（[server.js:254-266](file:///d:/ai_project/ai_work/Cadence/server.js#L254-L266)）。
- 生成窗口固定 `today-40d ~ today+80d`（[server.js:304-308](file:///d:/ai_project/ai_work/Cadence/server.js#L304-L308)）；`regenRule` 删除「本月及以后」的未完成实例后再按同一窗口重建（[server.js:318-332](file:///d:/ai_project/ai_work/Cadence/server.js#L318-L332)）。
- 前端只有三个页签（[app.js:1243-1245](file:///d:/ai_project/ai_work/Cadence/public/app.js#L1243-L1245)）；`cycleCN`/`cycleLabel`/`nodeDayText` 只有日/周/月（[app.js:1182](file:///d:/ai_project/ai_work/Cadence/public/app.js#L1182)、[1232-1233](file:///d:/ai_project/ai_work/Cadence/public/app.js#L1232-L1233)、[1223-1227](file:///d:/ai_project/ai_work/Cadence/public/app.js#L1223-L1227)）；规则表单周期下拉三项（[app.js:2533-2537](file:///d:/ai_project/ai_work/Cadence/public/app.js#L2533-L2537)）。
- 由此：年度工作只能在每年临时手工建，或建一条月常规后手动改，无法表达「每年 8 月 31 日」。

## 本轮要解决的三个真实坑

1. 年分支缺失：`cyclesBetween`/`stepPlanDate` 都要有 `year`，且年节点字段不能复用月规则的 `mo`。
2. 年度实例落在 80 天窗口外：建规则后日历与规则卡都看不到，像没生效。
3. `regenRule` 按「本月及以后」删、按窗口重建：窗口外的年度实例会被删掉且不重建；`upsertRule` 无白名单会让错值静默当月。

## 工作区状态（开工前）

`git status` 另有 4 个**不属于本任务**的未提交文件：`version.js`、`CHANGELOG.md`、`public/app.js`、`public/changelog.js`（0.9.7「历次更新记录」修复）。本任务按用户指示只写实现，**提交前必须由对方清场**；不 add、不回滚、不 stash、不 `--no-verify`。
