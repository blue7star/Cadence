# MOD-server-api · 同步、动作接口与可见性

paths: server.js

## 职责
`/api/sync` 增量提交、七个动作接口（accept/dispatch/undispatch/join/toggle/due/notice-seen）的各自判权，以及 `stateFor()` 可见范围。

## 公开行为
- `/api/sync`：`{me, tasks[], rules[], cats[], watch[], del}` → `{ok, rows, errors[], rev}`。
- 七个动作接口见 `DEVELOPMENT.md` §4，各自判权（走不了 sync 的归属校验）。`dispatch` 收 `{id, stageId?, who?}`：不带 stageId 派发所有待派发段；带已有 pending 子专项的 stageId 且给 who 时执行改派；另收 `{id, topStageId|topIndex, who}`：**一级阶段行的一步派发**（0.12.0）——为指定的一级阶段生成一条同名、同起止的二级节点并立即派成 pending 子专项，一级阶段自身不落 `who`。`undispatch` 收 `{id, stageId}`，只撤 pending。
- 认证：`/api/login`（工号+密码，失败文案统一「工号或密码不正确」，同「工号+IP」5 次锁 5 分钟；管理账号 `admin` 走同入口的独立分支）、`/api/logout`、`/api/password`（改密后吊销本人其它会话）、`/api/admin/initial-passwords`、`/api/admin/reset-password`、`/api/admin/sessions`（后三个仅管理账号）。
- 导出：`GET /api/export/tasks.csv`，无参数，只导会话本人直接负责/已承接的常规、专项与临时任务；一行一阶段（临时任务无阶段，整条占一行、阶段列留空），UTF-8 BOM + `\r\n`。27 列，末尾两列 `父任务编号` / `父任务阶段编号`（0.11.0）：子专项行填、顶层行空、续行留空；被派发阶段的「阶段负责人/阶段完成/阶段完成日」读子专项（派生）。第 14 列「完成日期」：有阶段任务取叶子阶段 `doneAt` 最大值；无阶段任务取 `task.done_at`（0.14.0），存量无值则留空。

## 不变量
- **身份只来自会话**：所有接口先过 `sid` cookie 的会话门，`me` 与会话不符 403、无会话 401；不接受「按请求里的 me 当身份」。导出因此没有「导别人」的口子。
- **停用即失效**：会话门每次都查 `emp.active`，停用（`active=0`）当场 401 并吊销该工号全部会话；不再有「停用后旧 cookie 还能用满 30 天」的窗口。
- **初始密码名单 = 仍在用初始密码的在职员工**：`cred.initial=1`，外加从没登录过、连 `cred` 行都还没有的人（密码同样是工号）；从未登录时 `firstLoginAt` 为空。
- **管理账号是独立身份**：`admin` 走 `/api/login` 的独立分支，会话门不查 `emp.active`，改查 `admin_auth` 是否还在；它不进花名册、不参与业务数据，改密前除 `/api/password`、`/api/logout` 外一律 403。**初始口令固定为 `123456`（2026-11-17 起，取代随机生成）**：`must_change=1`（含行不存在）时启动幂等对齐到 `123456` 并把固定口令打印到启动日志；`must_change=0` 时启动不写库、不打印，重启保留用户改后的密码，绝不重置回 `123456`。
- **sync 只接受 `owner_no=我` 的行**；请求缺的字段沿用库值；`errors` 非空前端必须原话告诉人。
- **无阶段任务的完成日期由服务端记录**（0.14.0）：`upsertTask` 对无阶段任务在 `status` 迁移时维护 `done_at`——`→ done` 写当天、`done → done` 保留原值、`done → 非 done` 置空；请求体里的任何完成日期一律忽略。反例：e2e「临时任务完成落库且导出同值」「取消完成清空」「存量已完成行导出留空」。
- **常规规则的周期只有 `day/week/month/year`**：`upsertRule` 用白名单判定，未知周期整条拒收并进 `errors`（不再静默落进月分支）；年规则每个节点必须有 `monthNo`（1-12）与 `day`（1-31），缺了同样拒收。反例：e2e 7.4b「服务端拒收未知周期与缺月日的年规则」。
- 接收看 `assignee_no`、派发/撤回/改派看 `owner_no`、加入待办与勾选看 `stages[].who`（须已派发）。**勾选只认这一段的责任人**；承接人对别人负责的段只读，`who` 为空（承接人自己做）时才由承接人勾。已派成子专项的段没有自己的勾选权，一律按「这一段由别人负责，只有他能勾完成」拒。
- **可见性六来源**缺一即「派完就断线」：我名下 ∪ 指派给我 ∪ 我发布 ∪ 下属常规/专项 ∪ 我负责某段（须 `whoAt` 非空）∪ 我作为知情人（只读）。子任务责任人挂在 `stages` JSON，SQL 过滤不到，整表取回再筛。
- **带父引用的子专项只从「我是负责人 / 我承接」进入**：publisher、下属专项、`source_id`、阶段责任人四条来源对它一律不成立；派发时父阶段的 `who/whoAt` 清空，所以原责任人不会从「我负责某段」再看到父任务一次。反例：e2e「派发人自己的列表里没有这条子专项」「责任人那边只多出这一条子专项」。
- **透视一层**：父任务 `state` 的阶段上挂 `child` 摘要（`id/title/status/intakeStatus/progress/ownerNo/assigneeNo/start/end`），不含子任务的 `stages`；子任务行对派发人不可见，因此拿不到二级阶段，也拿不到三级。
- **深度封顶**：新任务深度 = 父深度 + 1，> 3 整次拒绝（「子专项最多三层：这条已经是第三级，不能再往下派」）；判定在 `dispatchTask`，不只在界面。
- `INV-5 一级阶段行的一步派发只允许落在「未完成、未拆过的一级阶段」上`。拒绝点：`dispatchTask` 的 `topStageId/topIndex` 分支，逐条给可读原因——非 `owner_no`（只有承接人能派）、`taskDepth+1 > 3`（三层封顶同一句）、找不到阶段、目标 `pid` 非空（「这个入口只给一级阶段用」）、该一级阶段已完成、该一级阶段已有子阶段或已有子专项（「已经拆成子任务」）、`who` 为空、目标人不在花名册或未登录、任务类型不是 `assign/special`。落点仍是二级节点，一级阶段不存 `who`。反例：e2e 9.9b 六条直调拒收 + 第三级 `topStageId` 拒收。
- `INV-6 自动子段的撤回必须可回到「未拆、可派」`：一级行派发生成的节点带 `auto=1`；`undispatch` 删掉 pending 子专项后，若该节点 `auto` 为真则连同节点一起从 `stages` 移除，一级行恢复「谁做」；手动节点没有 `auto`，仍保留并把 `who` 还原。拒绝点：非 owner / 该段没有 pending 子专项 / 已接收；撤回后拿已移除的自动段 `id` 再派 → 「找不到这一段」。反例：e2e 9.9b「撤回后入口恢复 + 再派同一人 + 换人 + 旧 id 被拒」。
- **接收 = 所有权转移**（`owner_no` 变承接人、`type` 变 `special`），不派生副本；`publisher_no` 永不改；父引用保留。接收前不进对方日历（pending assign 本来就被 `isMineTask` 排除）。
- **完成态只有一条上行通道，且只有一份真相**：子专项的 `status` 是唯一真相，父阶段不存 `done`；子专项 status 变化 → `syncParentFromChild` 重算父任务 status（叶子按子专项完成态计）并写 `stage_notice(kind=stage_done)`。不做反向下写，父方整段提交里的 `done` 由 `applyChildOwnership` 清空。
- **删除只脱钩**：删父任务或父任务里的某一段 → 清空子专项的父引用并保留它；已接收的写 `kind=detached` 提醒。不级联删。
- **撤回 / 改派仅限接收前**：`undispatch` 删 pending 子专项、把 `who` 还原到父阶段（`whoAt` 仍空）；`dispatch{stageId, who}` 只改 pending 子专项的 `assignee_no`。已接收的换人/撤回本轮不支持，接口返回「已经被接收」。反例：e2e「已接收的子专项不能再改派」。
- **阶段区间是「计划」，判定在服务端**（`upsertTask` → `checkStageIntervals`，只对 `assign`/`special`；routine 的 stages 是当天节点，不按区间判）：
  - `INV-1 同层阶段区间不得相交`。闭区间；首尾相接（前一段到 11-06、后一段 11-07 起）合法；同一段自身不参与配对。拒绝点：`checkStageIntervals` ①；反例：e2e 6.9「压到中间段」「压到最后段」、直调 `/api/sync` 塞重叠段。
  - `INV-2 子阶段必须落在父阶段窗口内`（可等于边界）。拒绝点：`checkStageIntervals` ②（文案「超出所属阶段」）；反例：e2e 6.9「直调 /api/sync 塞子任务到父阶段窗口外」。
  - `INV-3 任务周期等于一级阶段的包络`（最早开始 → 最晚结束）。拒绝点：`checkStageIntervals` ③（文案「任务周期必须等于阶段包络」）；反例：e2e 6.9「直调 sync 让任务周期短于阶段包络」。
  - `INV-4 due ≥ 最晚阶段结束日`。拒绝点：`upsertTask` 的 `t.end > due_date`（`INV-3` 保证 `t.end` 就是包络）；反例：e2e 8.x 超截止。
  - 只判「这次写入改变了阶段区间」的请求：存量里的历史脏数据不挡改标题这类无关编辑；同一类判断前端也有一份，前端只负责当场提示，服务端才是判定者。

## 依赖与边界
- 依赖 `MOD-server-data`。
- 禁止：把接收与派发合并成一个动作（曾合并，后果是「活还没立项就先催人」）。
- 禁止：父阶段再存一份 `done`、或给子专项状态做双向回写（曾做过，结果是「谁最后写谁说了算」）。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-subtask-upstream | 见 git | — | 子任务完成上行汇总；勾选判权收紧到责任人；旧快照不得覆盖他人完成态 |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths: server.js`：模块归属由蓝图声明，M1 不再按文件名猜 |
| TASK-20261110-auth-export | 见 git | — | 认证（login/logout/password/管理账号重置）与会话门；导出 `/api/export/tasks.csv`；会话门加 `emp.active` 校验（停用即失效，并清该工号会话）；初始密码名单口径改为「仍在用初始密码的全部在职员工」，含从没登录、尚无 cred 行的人；管理账号改名为独立 `admin`（分表、不进 emp、首登强制改密），新增 `/api/admin/sessions` |
| TASK-20261113-export-temp | 见 git | — | 导出范围扩到 `temp`（本人负责/承接），类型列新增「临时」；临时任务无阶段，整条一行、阶段列留空 |
| TASK-20261111-stage-interval | 见 git | — | `upsertTask` 新增 `checkStageIntervals`：同层区间不相交（首尾相接合法）、子阶段在父窗口内、任务周期等于一级阶段包络；只判本次写入改变区间的请求，通过后把周期收敛到包络；INV-1~INV-4 落地 |
| TASK-20261116-year-routine | 见 git | — | 常规规则周期新增 `year`：`upsertRule` 加白名单（未知周期整条拒收并进 `errors`），年节点校验 `monthNo`(1-12)+`day`；实例 key=YYYY |
| TASK-20261112-rules-dedup | 见 git | — | 删除 4 条已被代码覆盖的公开行为（登录失败计数上限、派发 activated/stage_ref 独占、已派发叶子完成态以库为准、status 由叶子推）；INV-1~INV-4 保留为规范来源 |
| TASK-20261116-stage-dispatch-nesting | 见 git | — | 阶段派发落地为 pending 子专项，接收后成为独立专项；新增 `undispatch` 与 `dispatch{stageId,who}` 改派；可见集对子专项排除 publisher/下属/来源/阶段责任人；透视一层（`child` 摘要）；三层硬拦；完成态只读子专项；删除只脱钩；导出 27 列 |
| TASK-20261117-stage-top-who | 见 git | — | `dispatch` 新增 `{topStageId|topIndex, who}`：一级阶段行一步生成同名同起止的二级节点并立即派发；新增 INV-5（入口只认未拆过的一级阶段、一级阶段不存 `who`）与逐条服务端拒绝点；三层封顶与完成态权威不变。v2：`auto` 自动段撤回时连同节点收掉，一级入口恢复（INV-6） |
| TASK-20261117-admin-fixed-password | 见 git | — | 管理账号初始口令固定 `123456`：`must_change=1` 时启动幂等对齐并打印固定口令；`must_change=0` 时启动不写库、不打印，重启保留用户改后的密码 |
| TASK-20261118-temp-done-date | 见 git | — | `/api/sync` 对无阶段任务维护 `done_at`（完成写当天、取消完成清空、重复完成保留）；导出第 14 列无阶段任务改读 `task.done_at`，存量留空 |
