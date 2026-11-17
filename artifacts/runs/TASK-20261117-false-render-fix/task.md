# Task Contract — TASK-20261117-false-render-fix

## 元信息

task_id: TASK-20261117-false-render-fix
contract_version: 1
base_revision: 885cd46
gate_level: G1
status: PLANNED
owner: Planner
modules: app-ui, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理（M8）

requirement_quote: 「这里为什么没事设置都是flase。而且说的可以给阶段设这责任人我怎么没有找到窗口地方，这就叫交付吗。」「1. **修 false**：按你给的三元兜底改，不改任何业务口径。改完检查同一段模板里还有没有别的布尔直接插值，有就一并收掉。」「2. **确认 8788 跑的是不是当前构建**。`/api/version` 里构建串带的提交号必须等于 HEAD，否则重启。」「3. **把入口走到用户能看见**。先如实核实：从「专项工作 → 某条专项」进去，派发/设责任人这个入口在第几步、长什么样、需要什么前置条件（比如阶段得先有子节点）。然后判断它是否满足「没被告知过的人两步内能找到」…如果发现入口根本不存在（只是我以为存在），停下来说清楚差什么，不要顺手补一个我没批准的设计。」

user_problem: 用户打开 8788 的「专项工作」页，阶段行右侧出现字面量 `false`（本该是空白或负责人/待接收/进度）；同时他按之前「可以给阶段设责任人」的说法去找入口，在 `部门制度修订（考核细则）` 这类只有一级阶段的专项里完全找不到「谁做」。

out_of_scope: 不新增「一级阶段直接设责任人」或任何改变已批准口径（派发入口只在二级节点、一级阶段不带负责人）的设计；不改派发/接收/撤回/完成态的服务端语义与数据模型；不迁移老数据里已带 `whoAt` 的二级子任务；不改 8788 的启动方式或端口；不清理另一条已提交的 0.9.7 说明。

acceptance_command: node _dev/verify.mjs --full（期望退出码 0）

stop_conditions: ① 要让「一级阶段两步内能设责任人」必须改已批准口径（入口只在二级、一级不带 who）时，停下问人，不自行补设计；② 修 false 必须改服务端接口或数据才能生效时，停；③ 工作区出现非本任务的未清场改动时，停；④ 入口核实结果与代码不符、无法用截图自证时，停下说明。

## 目标与范围

- 业务目标与用户可见的成功：
  - 专项工作卡片里不再出现字面量 `false`；一级阶段行右侧恢复为空白，二级阶段行照旧显示姓名 / 待接收 / 进度。
  - 用连续截图说清「设责任人 / 派发」入口到底在第几步、需要什么前置条件；不满足两步时如实说明，不擅自扩设计。
- 范围内：
  - `public/app.js` 列表卡片模板：把 `${r.sub && (...)}` 改成带 `''` 兜底的三元，避免布尔 `false` 被插值成文本；同一模板内不再有其它布尔直接插值。
  - `_dev/e2e.mjs` 增加一条反例断言：专项工作卡片的阶段行文本里不得出现独立的 `false`。
  - `version.js` 新增 0.11.1（Z：用户可见缺陷修复），`node version.js --write` 生成 CHANGELOG。
  - 证据：1600 视口截图（列表修复后、无二级子任务的详情、有二级子任务的详情、点「+ 子任务」后的表单），`/api/version` 与 `git rev-parse --short HEAD` 的命令输出。
  - 蓝图变更历史：`app-ui.md`、`tooling.md`、`version.md` 各追加本任务一行。
- 范围外：见元信息 `out_of_scope`。
- 已批准的决策：
  - false 的成因与修法由用户确认：「按你给的三元兜底改，不改任何业务口径」。
  - 一级阶段不设负责人、派发入口只在二级节点，沿用 2026-11-16 v2 契约，不在本轮更改。
- 受影响的事实归属者与契约：`specs/modules/app-ui.md`（阶段行渲染）、`specs/modules/tooling.md`（e2e 反例）、`specs/modules/version.md`（0.11.1）。

## 风险与权限

- 风险理由（为什么是 G1 不是 G0）：改了用户可见的列表渲染路径，并新增 e2e 断言；不触碰数据模型、接口形状、身份与可见性。
- Human 已决策事项：修 false 的写法；入口不满足两步时先停下报告，不自创设计。
- Worker 不得自行决定的事项：给一级阶段加责任人控件；把派发入口提前到列表页；改派发/接收语义；调整 0.11.0 的历史文案。
- 允许的工作区与破坏性操作：只改 `public/app.js`、`_dev/e2e.mjs`、`version.js`、`CHANGELOG.md`、`specs/modules/{app-ui,tooling,version}.md`、`artifacts/runs/TASK-20261117-false-render-fix/`；不 `--no-verify`；不做破坏性 git 操作。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出 0；提交后 `python .agents/gates/gate.py --ci --repo .` 通过并贴原始输出。
- 集成与反向路径：
  - e2e：专项工作卡片阶段行文本不含独立 `false`，且同一页仍有阶段行（避免空集自证）。
  - 手工证据：`/api/version` 的版本串含 `<commit count>.<short hash>`，与 `git rev-parse --short HEAD` 一致。
- 文档同步：三份蓝图变更历史各一行。
- 安全、数据、迁移与回滚证据：纯前端模板修正 + 版本 Z 位，无迁移、无数据变更；回退该提交即恢复原渲染。
