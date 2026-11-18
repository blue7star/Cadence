# Task Contract — TASK-20261118-stage-overlap-and-create-who

## 元信息

task_id: TASK-20261118-stage-overlap-and-create-who
contract_version: 1
base_revision: 777d90f
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, app-ui, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理（M8）

requirement_quote: 「现象：发布任务时，第 1 段 2026-11-18→2026-11-19、第 2 段 2026-11-18→2026-11-20，被拦下并提示"压上了…把其中一段挪开再存"。用户的原话口径是**允许同层阶段时间重叠**……1. 放行同层阶段时间重叠，前后端一起放开，不要只改一边。重叠时不要弹黄色提示……2. 保留这两条真错误：段的结束早于开始仍然拒绝；子段必须落在父段窗口内。3. "任务的周期 = 一级阶段包络"按 min(开始) 到 max(结束) 收敛……4. 规格里的「同层不相交」不变量要删掉，并写清变更原因（用户口径变化）……5. 补测试：两段完全重叠可保存、三段一父两子重叠可保存、结束早于开始仍被拒、父窗越界仍被拒。」「发布任务弹窗的每个一级阶段行都要有「谁做」下拉，和详情页同一套候选、同一套语义。保存时：该段选了人的，自动生成同名、同起止时间窗的二级子段，责任人就是所选人，状态直接进「待接收」，走既有的派发/接收/上行通道，不要新开状态机。没选人的段保持原样。」「同一份能力要在所有能产生阶段的入口都齐：新建任务弹窗、详情页「+ 添加阶段」、阶段行「+ 子任务」。把这三处的现状列个清单给我，缺哪个补哪个。」

user_problem: ① 同一层两个并行阶段被前端 `validateStages` 与服务端 `checkStageIntervals` 同时判为「相交」，正常排期被拦，用户被迫挪日期；② 用户在发布任务弹窗里分段时看不到「谁做」，只能建完任务、退出、再进详情页补，入口不可发现；③ 三个阶段产生入口能力不一致（弹窗缺一级行选人，添加阶段表单缺「谁做」，加子任务选人后仍要再点「派发」）。

out_of_scope: 不改派发/接收/上行回流状态机；不改三层封顶、完成态权威、父子导出列、可见集口径；不引入自动排期或自动挪段；不改导出列；不改「子段必须在父窗口内」的判定；不改 total due 口径。

acceptance_command: node _dev/verify.mjs --full（期望退出码 0）

stop_conditions: ① 需要新开一条状态机或绕开既有 dispatch 通道；② 需要让一级阶段落 `who`；③ 需要放宽「子段超出父窗口」或「结束早于开始」；④ 改动会破坏三层封顶/完成态权威/导出列；⑤ 无法给出从发布弹窗开始的连续截图证据。

## 目标与范围

- 同层阶段重叠：前后端同时放行且不提示；`checkStageIntervals` 与 `validateStages`/`dragCheck` 中删除相交判定。
- 保留真错误：`结束 < 开始`（前端第 1 条 + 服务端新增拒绝点）、子段越出父窗口（两端都保留）。
- 周期收敛：前端 `restatTaskSpan` 与服务端 `stageEnvelope` 均按 min(开始) → max(结束)。
- 三个入口都支持「谁做」并选人即派：发布/新建弹窗一级阶段行、详情页「+ 添加阶段」、阶段行「+ 子任务」；一律复用 `POST /api/task/dispatch`（一级行用 `topStageId`，二级节点用 `stageId`），不新开状态机；一级阶段不存 `who`。
- 弹窗旧提示改为「选人即派、接收后生效」。
- 文档：删除 `MOD-server-api` INV-1 并写明口径变更；更新 `app-ui`、`SPEC.md`、`tooling`、`version`；版本 0.15.0（新能力 → Y）。
- 测试：两段完全重叠可保存、一父两子重叠可保存、结束早于开始被拒、父窗越界被拒、弹窗/添加阶段/加子任务三处选人即派、弹窗倒序日期被拒。

## 状态表

| # | 场景 | 前端 | 服务端 | 导出/周期 |
| --- | --- | --- | --- | --- |
| S1 | 同层两段完全重叠 | 放行、无提示 | 放行 | 周期 = min→max |
| S2 | 一父两子三段互相重叠 | 放行 | 放行 | 周期 = min→max |
| S3 | 段结束早于开始 | 拒（validateStages ①） | 拒（checkStageIntervals ①） | 不落库 |
| S4 | 子段超出父窗口 | 拒 | 拒（超出所属阶段） | 不落库 |
| S5 | 发布弹窗一级行选人 | 保存后立即 dispatch | 生成同名同起止二级节点 + pending 子专项 | 一级阶段无 who |
| S6 | 添加阶段选人 | 添加后立即 dispatch | 同上 | 同上 |
| S7 | 加子任务选人 | 添加后立即 dispatch | 二级节点落成 pending 子专项 | 同上 |

## 风险与权限

- 风险理由：阶段校验是前后端双份实现、派发是状态机入口、导出周期依赖包络 → G2。
- Human 已决策：允许重叠；保留两条真错误；周期 min→max；三处入口齐；截图从发布弹窗开始。
- Worker 不得自行决定：反向放宽真错误；让客户端直接建子专项；一级阶段存 who；改导出列。
- 允许的工作区：`server.js`、`public/app.js`、`_dev/e2e.mjs`、`specs/modules/{server-api,app-ui,tooling,version}.md`、`.agents/SPEC.md`、`version.js`、`CHANGELOG.md`、`DEVELOPMENT.md`、本 run 目录。验证只用 `_dev/.test-db` 副本。
- 停止与上报条件：见 out_of_scope / stop_conditions。

## 验收证据

- `node _dev/verify.mjs --full` 退出 0；提交后 `gate.py --ci` PASS。
- e2e：S1-S7 各自有断言；弹窗断言从 DOM 读「谁做」下拉并真实保存。
- 截图：1600 视口，从发布任务弹窗开始，连续展示「两段同日期 + 每行谁做可选项」→ 保存成功 → 越界仍被拒；文件在 `artifacts/runs/TASK-20261118-stage-overlap-and-create-who/walkthrough/`。
