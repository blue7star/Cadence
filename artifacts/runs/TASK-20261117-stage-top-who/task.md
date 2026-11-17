# Task Contract — TASK-20261117-stage-top-who

## 元信息

task_id: TASK-20261117-stage-top-who
contract_version: 1
base_revision: 2438947
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, app-ui, server-data, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理（M8）

requirement_quote: 「这里为什么没事设置都是flase。而且说的可以给阶段设这责任人我怎么没有找到窗口地方，这就叫交付吗。差的我都不想说」

user_problem: 只有一级阶段、还没拆二级子任务的专项，详情页的一级阶段行没有任何指定责任人的入口：用户想「把这一整段交给某人」，必须先点「+ 子任务」、填名称、选人、再点「派发」，3–4 步；入口本身也看不出来，被当成功能没交付。老数据里二级段 `whoAt` 已置位时，连「还有 N 段没派发」的提示条也不出现，等于没有可走的路。

out_of_scope: 不做已接收子专项的换人/撤回；不迁移、不改写老 `stage_ref` 镜像与已 `whoAt` 的旧二级段（只记录为已知限制）；不做父阶段与子专项的日期自动同步；不放开第四层；不新开第二条状态机（仍走 `dispatch → accept → syncParentFromChild` 同一条通道）；不改导出列、可见集口径与完成态权威；不动真实库 `data/workbench.db` 的业务数据（只读、只用副本做验证）。

acceptance_command: node _dev/verify.mjs --full（期望退出码 0）

stop_conditions: ① 一级入口必须把 `who` 落在二级阶段之外的一级阶段上才能实现（违反「一级阶段不存责任人」）；② 新入口无法复用既有派发/接收/上行通道，必须另开状态机或第二条完成态；③ 三层封顶、可见集或完成态权威需要被绕过才能实现；④ 必须让一级行与二级行的「谁做」同时可用来实现；⑤ 与既有不变量冲突且无解。

## 目标与范围

- 业务目标与用户可见的成功：
  - 在任务详情页，一级阶段行（尚未拆子任务）直接出现「谁做」下拉；选中同事后一步完成：生成一条同名、同起止时间窗的二级子阶段，立即派成「待接收」子专项，走既有接收/上行回流。不再需要「+ 子任务 → 填名 → 选人 → 派发」四步。
  - 派完之后，一级行不再出现该下拉，状态与后续操作（改派/撤回）只由二级行承担；两处入口不会同时改同一段。
  - 三级任务（`depth=3`）、已有子任务的一级阶段、非 `assign/special` 任务都不出现该入口；服务端同样拒绝直调。
- 范围内：
  - **服务端**（`dispatchTask` 扩展分支，不新增状态机）：`POST /api/task/dispatch` 新增入参 `{id, topStageId?|topIndex?, who}`——把指定的**一级**阶段（`pid` 为空）作为「整段交给某人」的入口：先补该一级阶段缺失的 `id`（老数据兼容），再生成一条 `pid=该一级阶段`、`name/start/end` 与它相同的二级节点（`who=目标人`），随后复用既有派发循环建 `type=assign / intake_status=pending / parent_task_id / parent_stage_id` 的子专项，并照旧清空该二级节点的 `who/whoAt`。一级阶段自身不落 `who`。
  - **服务端拒绝点**（逐条给可读原因）：任务不存在；非 `owner_no`（只有承接人能派）；`taskDepth+1 > 3`（沿用「子专项最多三层」同一句）；`topStageId/topIndex` 找不到阶段；目标阶段 `pid` 非空（这个入口只给一级阶段）；该一级阶段已有任何子阶段（两处入口不并存）；`who` 为空；目标人不在花名册或未登录过工作台；任务类型不是 `assign/special`。
  - **前端**（`stageTreeHTML` + change 处理）：一级阶段行在 `canEdit && !kids.length && depth<3 && (type=assign|special)` 时渲染可见的「谁做」标签 + 下拉（复用 `stageWhoOptions`）。选中人 → 调用扩展后的 dispatch；失败把下拉复位并原话提示；成功后 `refresh(true); render()`，一级行下拉消失、二级行显示「待接收 / 改派 / 撤回」。选择「承接人自己做」（空值）不发请求。已有子阶段的一级行不渲染该下拉。
  - **文案**：阶段卡片底部与任务信息里的引导改成「整段交给别人直接在这一行选『谁做』；要拆成几段分别给不同的人，再点『+ 子任务』」，让新入口可被发现。
  - **契约升版语义**：上一轮 `TASK-20261116-stage-dispatch-nesting` 的「派发入口仅开放给二级节点（`pid` 非空）」在入口层被本条扩为「一级行可直接发起派发」；但**落点仍是二级节点**，三级封顶、完成态唯一权威、导出父子列、可见集来源均不变。一级阶段仍不存 `who`（`applyStageOwners` 继续清空）。
  - **版本**：0.12.0（新能力 → Y 位），`node version.js --write` 生成 CHANGELOG。
- 范围外：见元信息 `out_of_scope`。
- 受影响的事实归属者与契约：`specs/modules/server-api.md`（dispatch 入参、拒绝点、一级入口不变量）、`specs/modules/app-ui.md`（一级行「谁做」、两个入口互斥）、`specs/modules/server-data.md`（老阶段 id 补写口径）、`specs/modules/tooling.md`（e2e 新断言）、`specs/modules/version.md`（0.12.0）、`DEVELOPMENT.md` §4（dispatch 入参）。

## 风险与权限

- 风险理由（为什么不是 G0/G1）：改动作接口入参形状、改阶段派生的写入结构（新增二级节点）、触及可见集/完成态既有权重的入口判定——落在 G2「接口形状、身份与可见性、阶段结构」范围。
- Human 已决策事项：入口补在一级阶段行；一步生成同名同窗二级子阶段并立即进入「待接收」；不新开状态机；二级行沿用现有下拉；保住三层上限、父子导出列、可见集与单份完成态；契约升版并写服务端拒绝点。
- Worker 不得自行决定的事项：给一级阶段落 `who`；新开第二条派发/接收/完成态通道；让一级行与二级行同时可改同一段责任；放宽三层上限或允许第四层；迁移/改写旧 `stage_ref` 与已 `whoAt` 的旧段；改导出列与可见集来源；改既有 e2e 断言的期望值（只允许补充新用例）。
- 允许的工作区与破坏性操作：只改本任务相关文件（`server.js`、`public/app.js`、`_dev/e2e.mjs`、`version.js`、`CHANGELOG.md`、`specs/modules/*.md`、`DEVELOPMENT.md`、`artifacts/runs/TASK-20261117-stage-top-who/`）；不触碰他人未提交文件；不 `--no-verify`；不做破坏性 git 操作；验证只在 `_dev/.test-db/` 副本上进行。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出 0（语法、版本、CHANGELOG、契约状态、门禁反例、工作区干净、e2e 全绿）；提交后 `python .agents/gates/gate.py --ci --repo .` 通过并贴原始输出。
- 正向路径（e2e，从 DOM 出发）：
  - 一级阶段行存在 `[data-act="stage-who-top"]`，且带可见的「谁做」标签（不是只有 title）。
  - 拨这个下拉选人 → 父任务 `stages` 新增 `pid=原一级阶段` 的节点，`name/start/end` 与原阶段一致；新节点 `who` 已清空；原一级阶段仍无 `who`。
  - 同时落一条 `parent_task_id/parent_stage_id` 的 pending 子专项，`assignee_no` = 选中人，`stage_ref` 为空。
  - 父方 `state` 里该一级阶段出现 `child.intakeStatus=pending`；一级行下拉消失，二级行显示「待接收」并给「改派 / 撤回」。
  - 老数据兼容：一级阶段没有 `id` 时，派发后服务端补了 `id`，子专项的 `parent_stage_id` 指向它。
- 反向路径（绕过界面直调 `/api/task/dispatch`）：
  - 非 owner → 拒；`who` 为空 → 拒；花名册外/未登录 → 拒。
  - 已有子阶段的一级阶段再走该入口 → 拒（「已经拆成子任务」）。
  - 传 `topStageId` 指向二级阶段 → 拒（「只给一级阶段」）。
  - 三级任务带 `topStageId` → 拒（「子专项最多三层」），且不留下半条子任务。
  - 类型为 `temp` 的任务 → 拒。
- 文档同步：四份蓝图 + `DEVELOPMENT.md` §4。
- 安全、数据、迁移与回滚证据：
  - 迁移：无表结构变更；只允许在一级阶段行派发时给缺失 `id` 的阶段补 `id`（写入 `stages` JSON）。
  - 回滚：回退代码即可；已补写的一级阶段 `id` 是普通既有字段，旧代码可读。
  - 数据安全：验证只在 `_dev/.test-db/` 副本上执行，不改 `data/workbench.db`。
