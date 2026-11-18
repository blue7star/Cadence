# Baseline — 上级透视与导出范围

采集于 `a22897d`（0.15.1+101.a22897d）。

## 1. 上级透视

- `server.js` `childSummaryOf(c, childMap)` 只返回 `{id,title,status,intakeStatus,progress,ownerNo,assigneeNo,start,end}`，**没有 `c.stages`**。
- `public/app.js` `stageTreeHTML`：
  - 一级行 `topWho = canEdit && !kids.length && ...`；有子任务时整块收起，同时也没有只读负责人。
  - 子任务行 `canEdit && k.child` 分支只显示「由 X 负责」；没有展开入口，也不渲染下属阶段。
- 现象：专项 21321 一级行只有「含 1 个子任务」，1.1 只有「由李明负责 · 进行中 50%」。

## 2. 导出

- `server.js` `exportTasksCsv(meNo)` 无参数、无范围；路由 `GET /api/export/tasks.csv` 不带 query。
- 前端 `exportTasks()` 直接下载；页头 `#exportBtn`，没有范围选择或预览。
- 列结构 27 列冻结；R2 续行规则（任务级列只在首行）。

## 3. 既有约束

- 子专项只从「我是承接人」进入父任务 owner 的可见集（`stateFor` 里 `parent_task_id && assignee_no !== meNo` 直接排除）。
- 派发/接收/完成态上行由 `dispatchTask` / `acceptTask` / `syncParentFromChild` 维护，本次不改。
- e2e 使用 `_dev/.test-db` 副本；父子关系需直接落库（`/api/sync` 不收 `parentTaskId`）。
