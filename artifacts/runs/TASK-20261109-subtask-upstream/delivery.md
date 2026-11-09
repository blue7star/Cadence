contract_version: 1
candidate_revision: 1
candidate_digest: 13e68ce1b90cb1f0d1614cd8c3f5f69b844db897e82edbf4bb3219102aed85b7
verify_commands: node _dev/verify.mjs --full; python .agents/gates/gate.py --fast --staged --repo .
not_run: none

# Delivery — TASK-20261109-subtask-upstream

## 交付内容

### 主口径（Human 2026-11-09 四条拍板）

- **完成态只能由责任人往上汇总**（`server.js`）
  - 新增 `pullStageFromMirror()`：派生副本（`stage_ref`）状态变化 → 回写父任务对应叶子 `done/doneBy/doneAt`、按叶子重算父任务 status、写 `stage_notice(kind=stage_done)`。这是唯一的上行通道。
  - 判权三道：`s.who` 非空、`s.who === mirror.owner_no`、`s.whoAt` 非空，缺一不回写；换人后的旧副本、伪造副本一律无效。
  - 删除 `mirrorStageDone()`（父阶段 → 副本的下行镜像），改为 `syncMirrorStatus()`：仅当「勾的人就是该段责任人」时对齐他自己那份副本；上级侧改动不再反写副本，双向循环消失。
  - `toggleStage()` 判权收紧：`who` 非空时只有该责任人（且已派发）能勾；`who` 为空时才由承接人勾。
- **上级整段写入不再覆盖责任人完成态**（`server.js`）
  - `keepForeignDone()`：`who` 指向别人且未换人的叶子，`done/doneBy/doneAt` 以库为准；新加的段、换了人的段一律从未完成开始。
  - 新建任务带 `done` 的叶子一律清零；INSERT 时客户端提交的 `stage_ref` 强制写 `null`，派生副本只能由 `/api/stage/join` 生成。
  - 新增 `dropStaleMirrors()`：换人、段被移除时服务端收走对应副本（副本界面没有删除入口，服务端不收就没人能收）。
- **状态由叶子推**（`server.js`）
  - `stageStatusFromLeaves()`：有子任务时全部完成才 `done`，一段没勾不许挂 `done`；`paused` 与手选的 `doing` 保留，只有不该成立的 `done` 会被掰回。
- **界面口径**（`public/app.js`）
  - `myTick`：`who` 非空时只给「我且已派发」的行渲染勾选框；别人那段显示「由 X 负责，完成由他勾」。
  - 派生副本：标题/起止/时间点/标准/分类/优先级只读，去掉删除按钮，只保留「完成情况」；文案改为「计划由承接人维护，你只需要做完后勾完成」。
  - 承接台「有变动的任务」支持 `kind=stage_done`（标签「完成」）；「加入待办」文案改为「计划和日期由承接人维护，你这边只勾完成；要调期找承接人」。

### 用例（`_dev/e2e.mjs` 9.11，13 条断言）

- 正向：责任人勾完成 → 上级 `done=true/doneBy=1003/status=doing`，`stage_done` 提醒恰好 1 条，上级详情「1 / 2」，承接台出现「完成」标签（UI 断言）。
- 反向 A：上级详情页别人那段无 `data-act="stage-toggle"`，直接调 `/api/stage/toggle` 被拒。
- 反向 B：第三人勾这段被拒。
- 反向 C：上级用旧快照（`done=false`、`status=done`）整段提交 → 完成态保留、status 不被写成 `done`；改结束日计划真的落库（断言到日期）；上级改计划后副本 status 不被翻动。
- 副本只读：标题只读、无起止输入、无删除按钮、状态下拉仍在。
- 失效率：父任务移除该段后，责任人那条副本被服务端收走（不留孤儿待办）。
- 提醒隔离：每轮开头先读掉上级旧提醒（`doneNotice === 1` 是精确值）；三级节点用例收尾同时读掉 1002 与 1012 的提醒，不留幽灵 `stage_done`。

### 文档与台账

- `specs/modules/server-api.md`、`specs/modules/app-ui.md`：不变量与变更历史登记本 task_id；补记「`/api/sync` 丢弃客户端 `stageRef`」「上行回写校验 owner/whoAt」「换人/移除收走旧副本」「`paused`/`doing` 保留」。
- `.agents/issues.md` #63（`requirement_gap`，已解决）。
- `.agents/archive/contracts/` 3 份：复核树摘要对齐本次绿报告 `a6030feb9974a28f`，并注明 2026-11-04 契约的「承接人可代勾任何一段」条款被本任务取代（历史结论未删除）。
- `version.js` / `CHANGELOG.md`：0.8.5（三组文案）。

### 复审轮次

- attempt 1（独立子代理）判 `FAIL_IMPLEMENTATION`，4 条 P1/P2 + 2 条 P3，原文存档 `evidence/verdict-attempt1-fail.md`。逐条修复：伪造/旧副本上行、新增叶子夹带 done、换人继承完成态、`paused` 被覆盖，并补提醒断言隔离、承接台「完成」标签、移除段后清理孤儿副本。
- attempt 2（另一独立子代理）复核确认上述 6 条全部修好、e2e 163 项 0 失败，但因「归档契约的复核树摘要滞后一代」导致 `verify --full` 退出码 1，判 `FAIL_IMPLEMENTATION`（实现无 P0/P1，阻塞点在门禁证据链），原文存档 `evidence/verdict-attempt2-fail.md`。
- 处置：按仓库既有「复核对象 = 上一份绿报告摘要」口径重跑 `--full` 并同步 3 份归档契约，绿报告树摘要 `a6030feb9974a28f`（7 项全绿、e2e 163 项）；随后提请 attempt 3 签署最终结论。

## 验证结果

- `node _dev/e2e.mjs http://127.0.0.1:8799`：163 项 PASS、0 FAIL（9.11 的 13 条断言全绿）。
- `node _dev/verify.mjs --full`（`CADENCE_BASE=http://127.0.0.1:8799`）：7 项全绿（语法 / 版本 / CHANGELOG / 契约状态 / 门禁反面用例 / 服务版本 / e2e），树 `a6030feb9974a28f`。
- `python .agents/gates/gate.py --fast --staged --repo .`：M1 契约准入、M3 蓝图同步通过。
- `python .agents/gates/gate.py --ci --repo .`：提交后由机器执行（M1-M6；M2/M6 依赖本份 PASS 事件，评审阶段必然 NOT_RUN）。
- 存量补数清单：本地库「副本已完成、阶段未完成」= **0 条**；反向（阶段已完成、副本未完成）与反指失效率同为 0 条。未落库、未触碰 172.17.0.85。
