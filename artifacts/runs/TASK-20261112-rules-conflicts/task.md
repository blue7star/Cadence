# Task Contract — TASK-20261112-rules-conflicts

> 规则体系体检第一批：只修矛盾，不删重复、不降级。

## 元信息

task_id: TASK-20261112-rules-conflicts
contract_version: 1
base_revision: 19a977e
gate_level: G2
status: PLANNED
owner: Planner
modules: tooling, app-ui, version
sibling_tasks: TASK-20261112-rules-dedup
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 「用户已批准执行你清单里的第一批（修 8 对矛盾）……8 对由你按清单裁决，裁决时选「让干活的人按文档做不会被门禁拦」的那一边。A05 vs A23（G0 轻口径）：取消 G0 轻口径，所有改动统一走 --full。C22 vs D58（版本号 bump）：按 semver 本义——修复 bump Z、新能力 bump Y、破坏性 bump X，删掉「用户可见变化一律 bump Z」。删的是文档里的复述，不是代码里的约束。」
user_problem: 8 处规则口径互相打架：按 AGENTS.md 的 G0 会绕过 --full，按复核清单的旧「第 3 段」找不到 verdict，归档档案允许补写历史复核，实践台账的证据指针指向已撤掉的 verify-report.json，版本 bump 与 semver 冲突，前端独有的周末规则被写成不变量，截图视口与 e2e 宽度不一致。干活的人按文档做会被另一条规则或门禁判错。
out_of_scope: 不做第三批「降级为代码判定」；不改任何业务代码（server.js、public/app.js、version.js、_dev/）；不新增任何规则；不重开历史契约的复核；本批不删纯重复项；不改 gate.py 的判定逻辑。
acceptance_command: `node _dev/verify.mjs --full`，期望退出码 0。
stop_conditions: 发现清单之外的新矛盾对；任何一条修正需要改业务代码才能自洽；e2e 因本次文档改动变红；需要修改 .agents/gates/gate.py 的规则；需要改写历史契约正文。

## 目标与范围

- 业务目标与用户可见的成功：同一件事只剩一种说法；按任意一份现行文档做事，不会被另一份文档或门禁判成违规。
- 范围内（in scope）：
  1. `AGENTS.md` §3：取消 G0 轻口径，所有改动统一 `--full`。
  2. `.agents/README.md`：修正「gate.py 是 M1-M8 唯一实现」与 `verify.mjs contracts()` 并存的表述。
  3. `.agents/review-checklist.md` A2/A4/D4：改绑 `delivery.md` 改动清单与 `verdict.md` 候选摘要，不再指向退役的一页三段。
  4. `.agents/archive/README.md`：归档契约整份只读，第 3 段不得补写、不得改 PASS。
  5. `.agents/practice/ai-native-engineering.md`：修正 `verify-report.json` 证据指针，追加本次口径修正记录。
  6. `specs/modules/version.md`：INV-4 改为 semver 三档口径。
  7. `specs/modules/app-ui.md`：删除只在前端存在的 INV-4（周末规则），并把自审视口与 e2e 对齐。
  8. 三份蓝图的变更历史各补一行。
- 范围外：见元信息 `out_of_scope`。
- 已批准的 L0-L2a 决策：G0 取消；版本号按 semver；其余 6 对由 Planner 按「按文档做事不被门禁拦」裁决。
- 受影响的事实归属者与契约：规则归 `MOD-tooling`；阶段 UI 不变量归 `MOD-app-ui`；版本口径归 `MOD-version`。

## 风险与权限

- 风险理由（为什么不是 G0）：改的是规则本身，改错会让后续所有任务按错误口径执行。
- Human 已决策事项：G0 取消；版本号按 semver 三档。
- Worker 不得自行决定的事项：不得顺手删纯重复项；不得顺手降级；不得修改 gate.py；不得新增规则。
- 允许的工作区与破坏性操作：`AGENTS.md`、`.agents/README.md`、`.agents/review-checklist.md`、`.agents/archive/README.md`、`.agents/practice/ai-native-engineering.md`、`specs/modules/{tooling,app-ui,version}.md`、`artifacts/runs/TASK-20261112-rules-conflicts/`。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出码 0；`python .agents/gates/gate.py --ci --repo .` 的原始输出随提交交付（本批无 PASS，预期为 no_evidence 退出 1，不自签）。
- 集成与反向路径：逐对核对 8 处冲突的两侧文本，确认只剩一种说法；grep 确认 `verify-report.json`、`契约第 3 段`、`1440 视口` 不再作为现行规则出现。
- 文档同步（蓝图 / specs）：三份蓝图各补变更历史一行。
- 安全、数据、迁移与回滚证据：纯文档改动；回滚为还原对应 md 文件，无数据与代码迁移。
