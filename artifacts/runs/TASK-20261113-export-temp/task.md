# Task Contract — TASK-20261113-export-temp

> 导出范围扩到临时任务；时间列与派生副本的往返损失作为待拍板项上报，不在本轮自行补列。

## 元信息

task_id: TASK-20261113-export-temp
contract_version: 1
base_revision: 5dacfc1
gate_level: G1
status: PLANNED
owner: Planner
modules: server-api, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 用户原话「目前导出，怎么只导了常规专项，临时任务也要导出」。要求：①范围扩到 temp，仍按「本人负责或本人承接」判定，与现有导出的同一条筛选同源，不另写一套；②临时任务无阶段，整条占一行、阶段列留空，沿用「无编号阶段照样占一行」的同一规则；③先查清任务级 time 不在 25 列里的往返缺口，补列位置、v1/v2、旧文件兜底必须报用户拍板，不得自行补列；④给出真实数量（本人 routine/special/temp 各多少、导出多少行）说明增量；⑤e2e 覆盖 temp 出现、阶段列全空、不含别人的任务与 assign。
user_problem: 导出只有常规与专项，录入条建的临时任务在文件里完全看不到；用户以为导出漏了数据。
out_of_scope: 不加导出列（含 time）；不改列顺序；不升 v2；不实现导入；不改其它接口；不动 data/。
acceptance_command: node _dev/verify.mjs --full（期望退出码 0）
stop_conditions: 需要改导出列才能满足；需要动库结构；需要放宽既有断言；工作区出现其它会话未提交文件。

## 目标与范围

- 业务目标与用户可见的成功：
  - 导出包含本人负责/承接的 temp，类型列写「临时」；
  - temp 整条 1 行、阶段 8 列全空；
  - 别人的 temp、我发布的 assign 仍不出现；
  - 本人 1012 导出行数 162 → 165。
- 范围内：server.js（exportTasksCsv 的类型集合与 TYPE_OUT）、_dev/e2e.mjs、specs/features/auth-and-transfer.md（§4.1/§4.4/C6/§5.2）、specs/modules/server-api.md、specs/modules/{tooling,version}.md、version.js/CHANGELOG。
- 范围外：见 `out_of_scope`。
- 已批准的决策：本轮只扩范围；time 列与 stage_ref 副本的往返损失待用户拍板。

## 风险与权限

- 风险理由（为什么 G1）：导出是已发布契约，错误会让人拿到缺字段/多别人的文件；但无库结构变更、无写入。
- Human 已决策事项：临时任务要导出；时间列未定前不得自行补列。
- Worker 不得自行决定的事项：是否加「时间」列、加在哪、是否升 v2、旧文件兜底、是否排除 stage_ref 副本。
- 允许的工作区与破坏性操作：仅上节「范围内」文件 + `artifacts/runs/TASK-20261113-export-temp/`。
- 停止与上报条件：见 `stop_conditions`。

## 验收证据

- 确定性检查：`--full` 退出码 0；`gate --ci` 原始输出随交付。
- 集成与反向路径：e2e 断言 temp 在文件里、类型「临时」、阶段列空、集合与 DB 直查一致、不含 assign 与别人的 temp。
- 文档同步：auth-and-transfer（范围/枚举/C6/§5.2）、server-api、tooling、version。
- 视觉证据：无界面变化，本轮跳过 1600 截图，理由已写进交付。
- 数据与回滚证据：真实数量见 `evidence/counts.json`；回滚为还原 server.js 的类型集合与 TYPE_OUT。
