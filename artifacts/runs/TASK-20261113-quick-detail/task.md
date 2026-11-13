# Task Contract — TASK-20261113-quick-detail

> 录入条两个出口分工：回车直接建；「＋ 临时任务…」打开完整弹窗并预填。

## 元信息

task_id: TASK-20261113-quick-detail
contract_version: 1
base_revision: 9d1df7b
gate_level: G1
status: PLANNED
owner: Planner
modules: app-ui, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 用户原话「临时任务 输入加回车快速创建，那这个新建临时任务按钮，是不是可以对临时任务进行细致化的设置，比如我要认识这个任务类型，优先级等等」。落地要求：回车 = 快速创建（现状保留）；「＋ 临时任务」= 打开已有完整新建弹窗，把录入条里已敲的标题、选中日期、时间预填进去，补类型/优先级/分类/达成标准；不另造表单；按钮文案与 tooltip 要能看出分工；输入为空也允许打开；日期 chip/时间框行为不变；e2e 至少补回车默认字段、点按钮不建任务且预填、弹窗提交落库一致。
user_problem: 回车与按钮做同一件事，按钮等于白占位置；想建一条带类型/优先级/分类/达成标准的临时任务，只能先快速建、再进详情逐个改，多绕一圈。
out_of_scope: 不改服务端、表结构、导出/导入；不改临时任务单日语义；不改其它新建入口；不引入新表单或弹层范式；不改列表与右栏。
acceptance_command: node _dev/verify.mjs --full（期望退出码 0）
stop_conditions: 预填需要改服务端；回车无法在现有表单里保留；需要放宽既有断言；工作区出现其它会话的未提交文件。

## 目标与范围

- 业务目标与用户可见的成功：
  - 标题里回车 → 直接建，字段走默认（其他/临时、无优先级、无达成标准）；
  - 点「＋ 临时任务…」→ 不建任务，打开完整弹窗，标题/起止/时间已预填；可补分类、优先级、达成标准；
  - 取消弹窗不丢录入条内容；为空时也能打开。
- 范围内：public/app.js（录入条按钮与占位文案、qdetail 动作、taskModalBody 支持 end/time 预填）、_dev/e2e.mjs、specs/modules/*.md、version.js/CHANGELOG。
- 范围外：见 `out_of_scope`。
- 已批准的决策：按钮文案「＋ 临时任务…」+ tooltip 说明分工；回车靠隐藏 submit 按钮保留；取消保留输入。

## 风险与权限

- 风险理由（为什么 G1）：改的是最高频创建入口的两个出口，若回车失效或预填错位，会直接影响日常录入。
- Human 已决策事项：见受理口径。
- Worker 不得自行决定的事项：临时任务跨多天、类型定义、阶段规则、导出格式、其它入口。
- 允许的工作区与破坏性操作：仅上节「范围内」文件 + `artifacts/runs/TASK-20261113-quick-detail/`。不得改 server.js、data/、.agents/gates/。
- 停止与上报条件：见 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出码 0；`gate --ci` 原始输出随交付。
- 集成与反向路径：e2e 用真实 Enter 建任务并断言默认字段；点按钮断言任务数不变、弹窗打开且标题/起止/时间预填；取消后录入条仍在；再次打开仍预填；弹窗提交后落库字段一致。
- 文档同步：app-ui 公开行为 + 三份 blueprint 变更历史。
- 视觉证据：1600 改前/改后 + 弹窗预填截图，逐条列问题。
- 安全、数据、迁移与回滚证据：无表结构、无迁移；回滚为还原 app.js 一个文件。
