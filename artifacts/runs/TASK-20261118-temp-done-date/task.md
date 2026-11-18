# Task Contract — TASK-20261118-temp-done-date

## 元信息

task_id: TASK-20261118-temp-done-date
contract_version: 1
base_revision: 5f657c6
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, server-data, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理（M8）

requirement_quote: 「临时任务需要有完成日期……临时任务被标记完成时记录完成日期并落库，导出时该列输出这个日期。取消完成再把状态退回去时，这个日期要跟着清掉（别留下"未完成但已完成日期有值"的脏数据）。……存量数据没有这个字段，补数方案先给我看，不要自己填假日期、也不要拿当前时间顶替历史记录。」

user_problem: 临时任务没有阶段，导出「完成日期」列只从阶段 `doneAt` 取，导致这一类任务完成后该列永远为空；用户无法从导出里知道临时任务哪天完成。取消完成后也没有可清空的字段，容易留下状态与日期不一致的脏数据。

out_of_scope: 不改有阶段任务的完成日期口径（仍取叶子阶段 `doneAt` 最大值）；不改常规任务、子专项的完成态来源；不做任何存量补数（只出方案，待用户确认）；不把 `done_at` 做成可编辑字段，也不在界面上单独展示；不改导出列顺序/格式版本。

acceptance_command: node _dev/verify.mjs --full（期望退出码 0）

stop_conditions: ① 需要改导出列顺序或格式版本才能实现；② 需要把完成日期改成用户手填或客户端可传；③ 需要对存量已完成任务自动补日期（本任务明确禁止）；④ 需要改有阶段任务的完成日期口径；⑤ 无法给出真实的导出行证据。

## 目标与范围

- 业务目标与用户可见的成功：
  - 临时任务（无阶段）从「未完成」标记为「已完成」时，服务端记录当天日期到任务级 `done_at`；导出「完成日期」列输出该日期。
  - 取消完成回到未完成时，`done_at` 清空，导出该列为空；不会出现「未完成但完成日期有值」。
  - 完成后反复编辑标题等字段，不会把完成日期刷成今天；保持第一次完成日期。
  - 存量已完成的临时任务 `done_at` 为空时，导出留空，不补假日期；补数方案单独给出、待确认后执行。
- 范围内：
  - **数据**：`task` 表新增 `done_at TEXT`（`CREATE TABLE` + `ensureColumn` 兼容老库）；仅无阶段任务使用。
  - **服务端（`upsertTask`）**：无阶段任务状态 `todo/doing/paused → done` 时写 `todayStr()`；`done → 非 done` 时置空；`done → done` 保留原值。客户端不能提交 `doneAt`（与 `doneBy/doneAt` 的阶段口径一致，服务端说了算）。
  - **导出**：无阶段且 `status='done'` 时「完成日期」= `done_at`；有阶段任务保持取叶子 `doneAt` 最大值。
  - **测试**：临时任务完成 → 库里有日期且导出行一致；取消完成 → 库与导出都清空；存量形状（直接写入 `done_at=NULL` 的已完成临时任务）→ 导出留空。
  - **文档/版本**：`server-api.md`（sync 口径）、`server-data.md`（新列）、`tooling.md`、`version.md`、`DEVELOPMENT.md` §5；版本 0.14.0。
- 范围外：见元信息 `out_of_scope`。
- 受影响的事实归属者与契约：`specs/modules/server-api.md`、`specs/modules/server-data.md`、`specs/modules/tooling.md`、`specs/modules/version.md`、`DEVELOPMENT.md`。

## 状态表（临时任务完成日期）

| # | 状态变化 | `done_at` | 导出「完成日期」 |
| --- | --- | --- | --- |
| D1 | 新建成未完成 | `NULL` | 空 |
| D2 | 未完成 → 已完成 | `todayStr()`（服务端当天） | 等于 `done_at` |
| D3 | 已完成 → 已完成（改标题等） | 保留第一次的值 | 等于 `done_at` |
| D4 | 已完成 → 未完成 | `NULL` | 空 |
| D5 | 存量已完成、`done_at` 为空 | 不写（禁止补假日期） | 空 |

## 风险与权限

- 风险理由：数据表加列 + 导出列语义 + 状态写入时机，属 G2「数据表结构与迁移、导出契约」。
- Human 已决策事项：临时任务要有完成日期；取消完成必须清空；存量补数先给方案、不得造日期。
- Worker 不得自行决定的事项：补数执行；用 `updated_at`/当前时间顶替历史；改列顺序；允许客户端传完成日期。
- 允许的工作区与破坏性操作：`server.js`、`_dev/e2e.mjs`、`version.js`、`CHANGELOG.md`、四份蓝图、`DEVELOPMENT.md`、本 run 目录；不 `--no-verify`；不做破坏性 git；验证只用 `_dev/.test-db/` 副本。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出 0；提交后 `gate.py --ci` PASS。
- 正向：临时任务 `todo → done`，DB `done_at` 为 `YYYY-MM-DD`；导出该行第 14 列为同一日期。
- 反向（脏数据）：`done → todo` 后 `done_at` 为 `NULL`，导出行该列为空。
- 存量：直接构造 `status='done' AND done_at IS NULL` 的临时任务，导出该列为空（不补今天）。
- 有阶段任务回归：原有「完成日期取叶子 doneAt 最大值」断言继续通过。
- 真实导出行：在真实库副本上创建临时任务 → 完成 → 调 `/api/export/tasks.csv`，贴出该任务的实际 CSV 行（副本用完删除，真实库不动）。
- 补数方案：`backfill-plan.md`（只给方案与 SQL，未执行）。
