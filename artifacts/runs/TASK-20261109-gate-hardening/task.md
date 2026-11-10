<!-- 治理改造：门禁接回真实代码面 + 受理闸。不改产品行为。 -->

# Task Contract — TASK-20261109-gate-hardening

> 由 Planner 写；`gate.py` 的 M1/M8/M3 读本文件。字段名改动需同步 `schemas/task.json` 与 `gates/gate.py`。

## 元信息

task_id: TASK-20261109-gate-hardening
contract_version: 1
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
gate_level: G2
status: PLANNED
owner: Planner
modules: tooling, server-api, app-ui, server-data, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 用户原话「全量引入 ai-native-engineering，避免一句需求就开工，确保项目能长期稳定运行」；本轮拍板「闸 1/2/4 立即上，M9 暂不做，M7 不接」
user_problem: 改 server.js / public/app.js 时契约门禁完全不触发——受保护面写的是脚手架默认的 app/，模块归属靠文件名猜；于是一句需求可以直接改代码并提交，门禁全绿
out_of_scope: 不接 M9 契约先行闸；不接 M7（只认 pytest，本项目用 e2e）；不建 docs/adr 目录；不改 server.js / public/；不改任何产品行为
acceptance_command: python .agents/gates/gate.py --selftest 期望退出码 0；node _dev/verify.mjs --full 期望退出码 0；python .agents/gates/gate.py --ci --repo . 期望退出码 0
stop_conditions: 出现必须改产品行为才能继续、或反面用例构造不出来时停下上报，不擅自扩大范围

## 目标与范围

- 业务目标与用户可见的成功：产品行为零变化；同一句需求再来时，门禁先在「没有契约 / 受理字段没写完」处拦下。
- 范围内（in scope）：
  - `.agents/gates/protected.json`：受保护面改为项目真实代码路径。
  - `gate.py`：M1 读配置 + 蓝图 `paths:` 声明归属；新增 M8 受理闸；新增 `--selftest` 反例。
  - `.githooks/pre-commit`：追加 `gate.py --fast --staged`，缺 python 失败退出。
  - `.agents/templates/task.md`：受理五字段；`delivery.md`：verify_commands 本地化。
  - `.agents/scripts/agent_workflow.py`：新 run 的 rule_epoch 提到 4。
  - 五份蓝图加 `paths:` 与变更历史行；AGENTS.md、`.agents/README.md`、`review-checklist.md`、CI job 名同步。
- 范围外：见元信息 `out_of_scope`。
- 已批准的 L0-L2a 决策：用户 2026-11-09 拍板闸 1/2/4 上、M9 暂缓、M7 不接、ADR 暂不建目录。
- 受影响的事实归属者与契约：`.agents/README.md`（门禁说明）、`AGENTS.md` 第 3/4/5/7 节、`specs/modules/*.md`（归属声明）。

## 风险与权限

- 风险理由（为什么不是 G0）：改动的是「什么改动必须带契约」这条规则本身；配错会让门禁过松（回到原状）或过紧（正常提交被堵）。
- Human 已决策事项：闸门取舍与优先级（见上）。
- Worker 不得自行决定的事项：不得顺手做 M9；不得改产品代码；不得降低既有 M1-M6 标准。
- 允许的工作区与破坏性操作：只改 `.agents/`、`.githooks/`、`.github/workflows/`、`specs/modules/`、`AGENTS.md`、`_dev/verify.mjs`；不动 `data/`、`server.js`、`public/`。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：见元信息 `acceptance_command`。
- 集成与反向路径：
  - `gate.py --selftest` 六个用例：正例放行；契约摘要漂移拦；受理字段缺失拦；占位符拦；模块不拥有该文件拦；旧 epoch 兼容。
  - pre-commit 双轨：hook 内含 `verify.mjs --hook` 与 `gate.py --fast --staged`。
- 文档同步（蓝图 / specs）：五份蓝图加 `paths:` 与变更历史行；AGENTS.md §3/§4/§5/§7 同步。
- 安全、数据、迁移与回滚证据（G3 必填）：不适用（未触数据与接口）。回滚方式：还原本次提交即可。
