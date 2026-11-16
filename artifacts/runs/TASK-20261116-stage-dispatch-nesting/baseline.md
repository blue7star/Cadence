# 基线 — TASK-20261116-stage-dispatch-nesting（阶段派发 → 子专项嵌套）

日期：2026-11-16　基线提交：`7c64691`（年常规已提交，工作区干净，`main` 比 `origin/main` 领先 1）

## 现状（改前，已核对）

- **派发 = 打时间戳 + 写提醒**：`dispatchTask` 只给 `stages[].who` 写 `whoAt` 并落 `stage_notice(kind=dispatched)`（[server.js:1082-1102](file:///d:/ai_project/ai_work/Cadence/server.js#L1082-L1102)）。派发本身不建任何任务行。
- **责任人「加入待办」才产生一条活**：`joinStage` 建 `type=temp` 行，用 `stage_ref` 反指父任务那一段（[server.js:1106-1140](file:///d:/ai_project/ai_work/Cadence/server.js#L1106-L1140)）。
- **完成态上行**：副本 `status` 变化 → `pullStageFromMirror` 回写父阶段 `done/doneBy/doneAt` 并重算父任务状态（[server.js:729-752](file:///d:/ai_project/ai_work/Cadence/server.js#L729-L752)）；父侧勾选时再 `syncMirrorStatus` 往下对齐副本（[server.js:1059-1066](file:///d:/ai_project/ai_work/Cadence/server.js#L1059-L1066)）。
- **可见集六来源**：我名下 / 指派给我 / 我发布 / 下属常规与专项 / 我负责某段（须 `whoAt`）/ 我作为知情人（[server.js:429-453](file:///d:/ai_project/ai_work/Cadence/server.js#L429-L453)）。
- **导出 25 列、一行一阶段**，第 25 列已是阶段级的「父阶段编号」（同任务内 `pid`）（[server.js:1560-1564](file:///d:/ai_project/ai_work/Cadence/server.js#L1560-L1564)）。
- **前端**：`occOn` 每条任务最多一个日历条目、`isMineTask` 排除未接收的 assign（[app.js:445-472](file:///d:/ai_project/ai_work/Cadence/public/app.js#L445-L472)）；进度按叶子完成数（[app.js:774-779](file:///d:/ai_project/ai_work/Cadence/public/app.js#L774-L779)）；阶段树只有子任务行有「谁做」（[app.js:2088-2124](file:///d:/ai_project/ai_work/Cadence/public/app.js#L2088-L2124)）。
- **e2e 旧链路**：9.9「发布 → 接收 → 派发 → 加入待办 → 变更提醒」（[_dev/e2e.mjs:2023-2149](file:///d:/ai_project/ai_work/Cadence/_dev/e2e.mjs#L2023-L2149)）、9.11「子任务完成上行 / 副本只读 / 回写」（[_dev/e2e.mjs:2221-2356](file:///d:/ai_project/ai_work/Cadence/_dev/e2e.mjs#L2221-L2356)）。

## 老数据核对（真实库，只读）

- `task` 共 578 行，列：`id,owner_no,assignee_no,type,title,std,start_date,end_date,time,status,cat1,cat2,imp,urg,stages,routine_id,plan_date,source_id,detached,intake_status,created_at,updated_at,publisher_no,due_date,stage_ref`。
- `stage_ref` 非空 2 行，均为 `temp`：
  - `st_1012_t4_s3a`（owner 1005，todo）→ 父 `1012_t4`（special/1012/doing），阶段 `s3a` 存在，`who=1005`、`whoAt`/`joinedAt` 均有值、`done=false`。
  - `st_tde9yuh19z_sd4jt24wmk`（owner 1004，done）→ 父 `tde9yuh19z`（special/1012/done），阶段存在，`who=1004`、`whoAt`/`joinedAt` 均有值、`done=true`。
- 结论：老镜像 2/2 结构自洽，无断链、无孤儿；本轮**不清洗**，保持只读可用。

## 本轮要解决的三个真实坑

1. **同一条活出现两次**：派发只写 `whoAt`，责任人从「我负责某段」再看到父任务，同时他还要「加入待办」才有自己的活——一份责任，两处呈现。
2. **完成态两条通道**：父阶段 `done` 与副本 `status` 双向对齐，谁最后写谁说了算（8.5 修过一次，机制没变）。
3. **并行分工无法表达**：子任务只能挂在父任务里，被分工的人拿不到一条可自己拆、自己排期的活；日历里主负责人也看不到「这一段已经在别人手上」。

## 工作区状态（开工前）

`git status --short --branch` 只有 `## main...origin/main [ahead 1]`，无未提交文件，无他人改动。
