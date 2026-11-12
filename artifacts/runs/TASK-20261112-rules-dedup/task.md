# Task Contract — TASK-20261112-rules-dedup

> 规则体系体检第二批：只删纯重复项，并修台账自相矛盾。不做降级。

## 元信息

task_id: TASK-20261112-rules-dedup
contract_version: 1
base_revision: 57e18c4
gate_level: G2
status: PLANNED
owner: Planner
modules: tooling, app-ui, server-api, server-data, version
sibling_tasks: TASK-20261112-rules-conflicts
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 「用户已批准执行你清单里的第一批（修 8 对矛盾）和第二批（删纯重复项，约 50 条）。第三批「降级为代码判定」不动。删除要留凭据：每一条被删的规则，在删除记录里写三样：原文位置、它原来挡什么、现在靠什么兜住。顺带修两处台账自相矛盾：#64 同时出现在未解决和已解决；统计行写 66 条（18/48）而表里实际 12/54。」
user_problem: 同一件事在 AGENTS.md、.agents/README.md、复核清单、issues.md 与五份模块蓝图里各写一份，措辞互有出入；改动时只改一处，另一处就变成错误口径。台账还出现编号重复与统计失真，引用会指错。
out_of_scope: 不做第三批「降级为代码判定」；不改任何业务代码（server.js、public/app.js、version.js、_dev/）；不新增规则；不删 archive 档案正文（整份只读）；不删带编号的领域不变量 INV-1~INV-4；不删模板字段；不放宽任何 e2e 断言。
acceptance_command: `node _dev/verify.mjs --full`，期望退出码 0。
stop_conditions: 删除项被 e2e / gate / 其他文档引用而会导致断链；发现某条其实在挡独有的真实风险；需要改业务代码才能自洽；需要改动 archive 历史档案；需要改 gate.py 判定逻辑。

## 目标与范围

- 业务目标与用户可见的成功：同一件事只剩一处权威表述；删掉的条目都能在实践台账里查到「原来挡什么、现在靠什么兜」；issues 编号不重复、统计与表一致。
- 范围内（in scope）：
  1. `AGENTS.md`：删 G2 四类触发面枚举、契约面下限五项、fail_source 八类表、不换 VERSION、其余红线指针、pre-commit 两条细节、`--hook` 与 `--full` 同一套（均改为指针或已由代码覆盖）。
  2. `.agents/README.md`：删受保护面/paths、M8 五字段、selftest 条数、--scope、M4 版本权威、pre-commit/CI 边界、门禁不生成派生账本、block 情形表。
  3. `.agents/issues.md`：删「一个编号只能被一份契约挂」；修 #64 重复（摘要问题改 #66 并结案）；统计改 11/55。
  4. `.agents/review-checklist.md`：删 A1-A4、B2-B6、D2（由 verify/gate/e2e 覆盖）。
  5. `specs/modules/app-ui.md`：删 8 条已被代码/e2e 覆盖或与其他蓝图重复的行为。
  6. `specs/modules/server-api.md`：删 4 条已被代码覆盖的行为。
  7. `specs/modules/server-data.md`：删 6 条已被代码覆盖或重复的行为。
  8. `specs/modules/tooling.md`：删 3 条已被代码覆盖的说明。
  9. `specs/modules/version.md`：删 2 条已被 `version.js --check` / `verify.mjs` 覆盖的说明。
  10. 五份蓝图各补一行本任务变更历史。
  11. 实践台账追加删除凭据表（每条：原文位置 / 原来挡什么 / 现在靠什么兜）。
- 范围外：见元信息 `out_of_scope`。
- 已批准的 L0-L2a 决策：只删纯重复/已被代码覆盖项；领域不变量编号保留。

## 风险与权限

- 风险理由（为什么不是 G0）：删的是规则，删错会让约束静默消失；必须逐条写清兜底位置。
- Human 已决策事项：第二批范围与删除留凭据的要求。
- Worker 不得自行决定的事项：不得顺手降级；不得删 INV 编号条目；不得改 archive；不得改代码或门禁。
- 允许的工作区与破坏性操作：`AGENTS.md`、`.agents/README.md`、`.agents/issues.md`、`.agents/review-checklist.md`、`.agents/practice/ai-native-engineering.md`、`specs/modules/{tooling,app-ui,server-api,server-data,version}.md`、`artifacts/runs/TASK-20261112-rules-dedup/`。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出码 0；`python .agents/gates/gate.py --ci --repo .` 原始输出随交付。
- 集成与反向路径：`grep` 确认被删条目的关键词不再出现在现行规则文件；issues 表内编号唯一；统计数等于表内行数。
- 文档同步（蓝图 / specs）：五份蓝图各补变更历史一行。
- 安全、数据、迁移与回滚证据：纯文档改动；回滚为还原对应 md 文件，无数据与代码迁移。
