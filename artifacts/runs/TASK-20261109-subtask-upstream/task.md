# Task Contract — TASK-20261109-subtask-upstream

## 元信息

task_id: TASK-20261109-subtask-upstream
contract_version: 1
base_revision: 5a523476827f8fadf58f8245079443df1b9636b1
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, app-ui
sibling_tasks: none
blueprint_impact: updated
parallel_group: none

## 目标与范围

- 业务目标与用户可见的成功：
  专项工作把子任务派给下属后，**完成状态由责任人自己维护、向上汇总给上级**：
  ① 下属在自己的待办里勾完成，上级的任务详情进度、阶段勾选态、任务状态同步变化；
  ② 上级不能代替下属勾这一段（只读），仍保留改期、换人、改总截止；
  ③ 下属完成后上级在承接台「有变动的任务」看到一条“完成”，不弹窗；
  ④ 下属那条派生副本只允许改完成情况，标题/日期等计划字段归承接人；
  ⑤ 上级用旧快照整段提交，不会冲掉下属已勾的完成。
- 范围内（in scope）：
  - `server.js`：`upsertTask()` 的 stages 合并、`toggleStage()` 判权、派生副本 `stage_ref` 的上行回写、`stage_notice` 新增完成提醒；
  - `public/app.js`：子任务勾选框的可用性、派生副本的只读口径与文案、承接台提醒标签；
  - `_dev/e2e.mjs`：正向与三条反向用例；
  - `specs/modules/server-api.md`、`specs/modules/app-ui.md` 蓝图与 `version.js` 版本说明。
- 范围外（out_of_scope）：
  - 不改表结构、不改 `/api/sync` 的请求/响应形状；
  - 不改阶段日期校验 `validateStages()` 与日历算法；
  - 不改“接收 = 所有权转移”“派发必须 activated”等既有口径；
  - 不做存量补数的落库（本轮只产出清单与条数，落库等 Human 确认）；
  - 不引入单元测试框架（AGENTS.md §7 的 T1 约束仍然有效）。
- 已批准的 L0-L2a 决策（Human 2026-11-09 拍板）：
  ① 上级不再能代勾子任务，只保留计划类权限（改期/换人/改总截止）；
  ② 下属完成后提醒上级，走承接台「有变动的任务」，不弹窗；
  ③ 派生副本只允许改完成情况，计划字段归承接人，文案同步改口径；
  ④ 存量只补“副本已完成而阶段未完成”的空，不做反向回退，落库前先报清单。
- 受影响的事实归属者与契约：
  - `.agents/SPEC.md` §3.2「六个动作接口各自判权」与「任务归属三列」；
  - `specs/modules/server-api.md` 的不变量（sync 只收 owner=我 / 动作接口判权）；
  - `specs/modules/app-ui.md` 的不变量（两份 UI 各写各的、`ownRows()` 只提交自己的行）。

## 风险与权限

- 风险理由（为什么不是 G0）：
  触及 `/api/sync` 的 stages 合并语义、动作接口的判权（谁能勾）、派生副本的写权限与提醒通道，
  属于契约面（接口形状 + 权责口径 + 数据一致性），不是文案/样式微调。
- Human 已决策事项：见上四条（含“不做双向 mirror 循环”）。
- Worker 不得自行决定的事项：
  - 是否放开上级代勾（已明确：不放开）；
  - 是否把完成提醒做成弹窗（已明确：不做）；
  - 存量补数是否落库（必须 Human 确认清单后再执行）；
  - 是否顺手改阶段日期校验、日历、接收/派发语义（范围外）。
- 允许的工作区与破坏性操作：
  只允许改动本仓库工作区与本地 `data/workbench.db`（已有备份）；
  **禁止触碰 172.17.0.85 上正在运行的实例及其真实数据**。
- 停止与上报条件：
  e2e 出现无法在契约范围内解释的失败；发现需要改动表结构；发现存量补数会影响非“只填空”的数据。

## 验收证据

- 确定性检查（命令 + 期望退出码）：
  - `node _dev/verify.mjs --full` → 退出码 0（含语法、版本一致性、e2e 全绿）；
  - `python .agents/gates/gate.py --ci --repo .` → M1/M3/M4/M5 通过（M2/M6 依赖独立 Reviewer 的 PASS 事件）。
- 集成与反向路径（e2e 断言到具体结果，不是“没报错”）：
  - 正向：责任人勾完成 → 上级 `/api/state` 里该 stage `done=true`、`doneBy=责任人`，任务 status 与进度同步；
  - 反向 A：上级调 `/api/stage/toggle` 勾下属那段 → `ok:false`，界面上该行没有 `data-act="stage-toggle"`；
  - 反向 B：非责任人（第三个下属）勾 → `ok:false`；
  - 反向 C：上级用旧快照（done=false）整段提交 → 阶段仍 `done=true`，任务 status 不被改成矛盾值；
  - 提醒：上级 `/api/state` 的 `notices` 出现 `kind=stage_done`，承接台显示“完成”；
  - 不动副本：上级改期后，下属派生副本的 status 不被写回或翻动。
- 文档同步（蓝图 / specs）：
  `specs/modules/server-api.md`、`specs/modules/app-ui.md` 变更历史登记本 task_id。
- 安全、数据、迁移与回滚证据：
  无表结构变更；回滚 = revert 本次提交，派生副本与阶段仍是同一份 stages JSON，无新增字段。
