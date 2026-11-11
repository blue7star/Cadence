# Task Contract — TASK-20261111-stage-interval

> 事故驱动的一轮：阶段区间校验误报 + 领域约束没有服务端判定点。需求与口径见 `baseline.md` 与用户原话。

## 元信息

task_id: TASK-20261111-stage-interval
contract_version: 3
base_revision: 40725ae
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, server-data, app-ui, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 用户已拍板，按下面做。核心不是修这一个 bug，而是补上体系里缺的那个位置。一、修 bug（口径我定了，不用再问）1. 规则 5 改为同层区间两两相交判定（O(n²)，不依赖数组顺序）；首尾相接合法；改期时自身不参与配对。2. 报错文案收短：点名两段（含序号）、写完整日期（带年）、给出相交区间、一句怎么改。不动全站 fmt()，提示单用完整日期格式。3. 新增/改期后按 start 稳定重排同层阶段，编号跟时间走（方案 B）；注意 data-idx 重读 DOM，复查按下标操作的 e2e 断言。4. 纯周末段放行（阶段是区间，覆盖周末正常）；拖拽那条"不许排周末"不要套到区间上。5. 把区间校验搬到服务端 upsertTask：重叠、父子区间越界、任务 end 不能超过 due 之前已有那条继续保留——服务端直接拒绝并回可读原因。前端保留提示，服务端是判定者。二、补体系空位（这是重点，要轻）在现有蓝图（specs/modules/*.md）里，为每个业务对象补 3–5 条不变量，一句话一条、带编号（如 INV-1 同层阶段区间不得重叠）。不要新建目录、不要新建门禁。每条不变量必须满足两个条件：有一个服务端拒绝的实现点；有一条 e2e 反例（能证明它被拒绝）。本轮至少覆盖：阶段区间不重叠、子阶段落在父阶段区间内、任务周期等于一级阶段包络、due ≥ 最晚阶段结束日。三、实践记录写进既有台账 .agents/practice/ai-native-engineering.md（追加，不改旧条目），记这次事故：现象、四层根因（代码/入口/测试/体系）、为什么门禁全绿仍然漏、改进项。fail_source 用 invariant_gap 并说明为什么不是 requirement_gap。四、验证 e2e 补：跨年、压中间段、压最后段、首尾相接放行、改期到原日期放行、直接调 /api/sync 塞重叠段被拒（证明服务端真的在拦）。跑 --full，提交带 Task: trailer，gate --ci 绿，推 main。做完报一次，不要自开新复核轮。
user_problem: 阶段是跨年区间串，但校验把"同层有序"实现成"数组相邻且后一项更晚"，新增段一律排到数组末尾，于是合法空档被误判成与最后一段重叠；同时这条领域约束只活在前端，绕过界面直写 /api/sync 可以造出重叠、子任务越界、任务周期与阶段包络不一致的脏数据，而所有门禁都是绿的。
out_of_scope: 不做导入；不改 routine 的"当天节点"语义；不重写拖拽交互；不动全站 fmt() 短格式；不新增目录、不新增门禁、不新增依赖；不迁移或清洗老库存量脏数据；不放宽任何既有 e2e 断言（夹具违反新不变量时修正夹具本身，并在交付里写明）。
acceptance_command: node _dev/verify.mjs --full（自起 8799 测试库副本实例，期望退出码 0）
stop_conditions: 出现以下任一情况立刻停下问人：服务端口径需要与前端做出不一致的取舍；需要改 task 表结构；老库存量数据导致保存路径被大面积拒绝（要改为迁移方案而不是继续加拦）；e2e 既有断言必须放宽才能变绿；需要引入新的 npm 依赖。

## 目标与范围

- 业务目标与用户可见的成功：
  - 往跨年阶段中间插一段合法空档（如 2026-11-07→11-08）能直接存进去，不再被“占到 6月30日”拦下；
  - 真正重叠时，提示点名两段（带序号）、给出带年份的起止与重叠区间，并说明怎么改；
  - 阶段编号跟时间走：新加的一段落在它该在的位置，不出现“第 6 段日期比第 3 段早”；
  - 纯周末的阶段区间可以建；拖拽不再以“周末不铺阶段条”为由拦阶段区间；
  - 绕过界面直接调 `/api/sync` 塞重叠段、越界子任务、与阶段包络不符的任务周期，会被服务端拒收并回可读原因。
- 范围内（in scope）：
  - `public/app.js`：规则 5 改区间两两相交（排除自身、首尾相接合法）；`overlapMsg` 带年/带序号/带重叠区间；`validateStages` 通过后同层按 start 稳定重排；`stage-add` 补任务周期回算；`dragCheck` 去掉阶段区间的周末拦截。
  - `server.js`：新增 `checkStageIntervals`（同层不相交、子阶段在父窗口内、任务周期等于一级阶段包络），在 `upsertTask` 落库前判定；只对 `assign`/`special`，且只判“本次写入改变了区间”的情况；通过后把任务周期收敛到包络。
  - `_dev/e2e.mjs`：6 条新断言（跨年空档放行、压中间段、压最后段、首尾相接放行、改期到原日期放行、直调 sync 被拒×3 类）。
  - `specs/modules/*.md`：按对象补 3–5 条不变量（INV-n），每条注明服务端拒绝点与 e2e 反例。
  - `.agents/practice/ai-native-engineering.md`：追加本轮事故记录（`invariant_gap`）。
  - `.agents/review-checklist.md`：补一条“领域约束是否每条都有服务端拒绝点与反例测试”。
  - `version.js`：bump 0.9.2 并写 CHANGELOG（用户可见变化）。
- 范围外：见元信息 `out_of_scope`。
- 已批准的 L0-L2a 决策：
  - 判定权在服务端（前端提示只是提前说）。
  - 首尾相接合法；同一段自身不参与配对；改期排除自己。
  - 同层按 start 稳定重排，编号跟时间走（方案 B）。
  - 纯周末段放行。
  - 存量脏数据不在保存路径上被拦（只判本次写入改变区间的请求），避免“改标题被自己没做过的事拦住”。
- 受影响的事实归属者与契约：
  - 阶段结构与落库判定归 `MOD-server-api` / `MOD-server-data`；阶段 UI 与提示归 `MOD-app-ui`；e2e 与复核清单归 `MOD-tooling`；版本归 `MOD-version`。

## 风险与权限

- 风险理由（为什么不是 G0）：动的是服务端写入判定与所有阶段写入口，判错会让正常编辑被拒；重排会改变编号与下标语义，e2e 有按下标操作的位置。
- Human 已决策事项：见上节 5 条口径。
- Worker 不得自行决定的事项：是否允许阶段间空隙（保持允许）、是否拦存量脏数据（不拦）、提示文案之外的字段语义、e2e 断言是否放宽（不放宽）。
- 允许的工作区与破坏性操作：`server.js`、`public/app.js`、`_dev/e2e.mjs`、`specs/modules/*.md`、`.agents/review-checklist.md`、`.agents/practice/ai-native-engineering.md`、`version.js`、`artifacts/runs/<本任务>/`；不得改 `data/workbench.db` 既有任务；不得改 `.agents/gates/*`。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出码 0；`python .agents/gates/gate.py --ci --repo .` 全 PASS。
- 集成与反向路径（新增 e2e 断言，缺一不算过）：
  - 跨年五段夹具（含 11-06 与 11-09 的空档）能建；把 11-07→11-08 加进空档放行，且排在第 3 段；
  - 压第 3 段（11-01→11-10）被拦，提示含两段名与 `2026-11-09 到 2026-11-10`；
  - 压第 5 段（2027-06-20→07-05）被拦，提示含 `2027`；
  - 07-01→07-02 接在 06-30 后放行，任务周期跟到 07-02；
  - 原样保存某段日期放行；
  - 直调 `/api/sync`：重叠段、越界子任务、周期短于包络，三类都回 errors 且库里不动。
- 文档同步（蓝图 / specs）：`specs/modules/*.md` 各补 INV 条目与变更历史一行；`review-checklist.md` 补一条；实践台账追加记录。
- 安全、数据、迁移与回滚证据：
  - 回滚：还原 `server.js` / `public/app.js` / `_dev/e2e.mjs` 与文档即可，无表结构变更、无数据迁移。
  - 存量数据：不改库；只在“阶段区间被这次写入改变”时判定，改标题等无关编辑不受影响。
