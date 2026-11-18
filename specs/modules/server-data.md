# MOD-server-data · 数据层与实例引擎

paths: server.js, data/

## 职责
建表（`emp/task/rule/cat/task_observer/stage_notice/watch/op_log/meta/holiday/cred/sess/admin_auth`）与常规实例生成引擎（`ruleSteps` / `cyclesBetween` / `ensureInstances` / `maintain`）。

## 公开行为
- 首次启动自动建表；表结构变更须兼容已有 `data/workbench.db`（`ALTER TABLE` 前先查 `pragma table_info`，加字段给默认值，不改已有列含义）。
- `maintain()` 每次取 state 前按窗口补齐常规实例：日/周/月 `today-40d ~ today+80d`，年常规 `today-40d ~ today+366d`。
- **阶段派发的父子关系**落在 `task.parent_task_id` + `task.parent_stage_id` 两列（0.11.0），不再往 `stage_ref` 的 JSON 里塞。唯一约束 `UNIQUE(parent_task_id, parent_stage_id) WHERE 两列均非空`：一段最多派出一条子专项，也是派发幂等的依据。
- 该 partial unique index 的**左前缀就是 `parent_task_id` 的查询索引**，不另建冗余单列索引——别把它当成漏建。
- 删除父任务或父任务里的某一段只做**脱钩**（清空子任务的两列父引用），不级联删子任务；已接收的子专项会收到一条 `kind=detached` 提醒。
- **老数据的一级阶段可能没有 `id`**（0.11.0 之前的阶段 JSON 只存名称/日期）。一级阶段行派发时由服务端补一个 `id` 再挂子专项，`parent_stage_id` 直接指向它；不改表结构，旧代码仍可读。
- **`admin_auth`**：独立管理账号，只存 `account`、scrypt 哈希、`salt`、`must_change`。初始口令固定 `123456`；启动时仅在 `must_change=1`（或行不存在）时把它幂等对齐到初始口令，`must_change=0` 时一律不动。改密必须同时把 `must_change` 置 0，否则下次启动会被重置回初始口令。
- **`stages[].auto`（历史字段，0.16.1 起不再生成）**：0.12~0.16 的一级行派发会在阶段 JSON 里补一条同名、同起止的二级节点并标 `auto:1`。0.16.1 起子专项直接挂一级段，服务端不再写这个标记；老库由 `migrateFlattenDispatch()` 在启动时幂等迁移——把子专项改挂一级段、删除 `auto` 节点，删前用 `dbStats()` 采集前后行数/段数/子专项数并断言不再有「一级段 + 同名同起止 auto 子段」。迁移只改 `stages` 与 `parent_stage_id`，不碰任何任务 status；`--migrate` 只跑迁移并打印 JSON，正常启动也会跑一次（有改动才打日志），执行前 `VACUUM INTO` 备份。
- **`task.done_at`**（0.14.0）：无阶段任务（临时任务）的完成日期，`YYYY-MM-DD`，由 `upsertTask` 在状态迁移时写入，客户端不可提交。`todo/doing/paused → done` 写服务端当天；`done → done` 保留第一次的值；`done → 非 done` 置空。存量已完成行保持 `NULL`，不补假日期；有阶段任务不使用该列（完成日期仍取叶子阶段 `doneAt` 最大值）。

## 不变量
- **实例幂等**：同一 owner + 规则 + 周期只能有一条（`INSERT OR IGNORE`）；重复跑 `maintain` 不产生新行。
- **规则重排只动生成窗口内的实例**：`regenRule` 删除范围是 `routineWindow(rule)` 的 `[from,to]`（日/周/月 +80d、年 +366d），窗口外的年度实例不会被删掉；反例：e2e 7.4b「改规则后年实例仍在」。
- `INSERT` 列名与 `run()` 参数必须成对改，加列忘补参数只能等运行时炸。
- `INV-1 未激活（从没登录过）的工号不能成为承接人或子任务责任人`。拒绝点：`upsertTask` 的 `activated` 校验；反例：e2e「绕过界面直接调接口，派给没登录过的人也进不去，并带回原因」。
- `INV-2 已派发段的完成态以责任人为准`：非责任人的整段提交（旧快照、伪造副本）不得覆盖 `done/doneBy/doneAt`。拒绝点：`keepForeignDone`（旧镜像段）与 `applyChildOwnership`（已派成子专项的段）；反例：e2e「上级用旧快照改标题：标题落库，但子专项的完成没被冲掉」。
- `INV-3 task.start_date/end_date 必须等于其 stages 中一级阶段的包络，due_date 不早于该包络`。拒绝点：落库前的 `checkStageIntervals`（见 `MOD-server-api` INV-3/INV-4）；反例：e2e 6.9「直调 sync 让任务周期短于阶段包络」。
- `INV-4 子专项的 status 是完成态的唯一真相`：父阶段不落自己的 `done`，读侧由 `stagesWithChild` 从子专项派生，写侧由 `applyChildOwnership` 强制清空；父任务 status 由 `syncParentFromChild` 单向汇总。反例：e2e「责任人完成子专项 → 父阶段由子专项派生为完成」。父引用只能由派发写入，客户端整段提交里的 `parentTaskId/parentStageId` 一律忽略。

## 依赖与边界
- 依赖 `node:sqlite`（零第三方）、`version.js`。
- 禁止：前端直接写库；`temp`/`routine` 拉平（无 `pid`）。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths: server.js`：模块归属由蓝图声明 |
| TASK-20261110-auth-export | 见 git | — | 新增 `cred`（scrypt 口令）、`sess`（会话）、`admin_auth`（独立管理账号）三表；导出只读；管理账号不占工号、不进 `emp`，初始密码首次启动随机生成并只打印一次；`op_log` 加条数上限，裁剪只删「不是某人第一条 login」的旧行 |
| TASK-20261111-stage-interval | 见 git | — | 任务行与阶段表的区间自洽（INV-3）：落库前由 `checkStageIntervals` 判定并把 `start_date/end_date` 收敛到一级阶段包络；补充 INV-1（未激活不可派活）与 INV-2（完成态归属）的编号，行为未变 |
| TASK-20261112-rules-dedup | 见 git | — | 删除 6 条已被代码覆盖或与其他蓝图重复的公开行为（实例幂等、task 三列归属、工作日生成、op_log 上限、口令/会话/导出只读、admin 分表重复）；保留 INSERT 成对与 INV-1~INV-3 |
| TASK-20261116-year-routine | 见 git | — | 常规实例生成窗口按周期分档（日/周/月 +80d、年 +366d）；`regenRule` 删除范围从「本月及以后」改为「本次生成窗口内」，窗口外年实例不再被删；补年周期切分与 `monthNo` 落点 |
| TASK-20261116-stage-dispatch-nesting | 见 git | — | 新增 `parent_task_id`/`parent_stage_id` 与 partial unique index（唯一约束即查询索引）；阶段派发落地为子专项，完成态单向后汇总（INV-4）；父任务/父阶段删除只脱钩、不级联 |
| TASK-20261117-stage-top-who | 见 git | — | 无表结构变更；一级阶段行派发时为缺 `id` 的老阶段补写 `id`（写入 `stages` JSON），使子专项的 `parent_stage_id` 可挂载；v2 新增 `stages[].auto` 内部标记（撤回自动段时用，非导出列） |
| TASK-20261117-admin-fixed-password | 见 git | — | `admin_auth` 无结构变更；初始口令口径从「每次启动随机生成」改为固定 `123456`，仅 `must_change=1` 时启动幂等写入，`must_change=0` 时不动库 |
| TASK-20261118-temp-done-date | 见 git | — | `task` 新增 `done_at TEXT`（`CREATE TABLE` + `ensureColumn` 兼容老库）：仅无阶段任务使用，状态迁移时由服务端写/清，客户端不可提交；存量已完成行不补值 |
| TASK-20261118-flatten-dispatch-mirror | 见 git | — | 无表结构变更；新增幂等迁移 `migrateFlattenDispatch()`：把挂在 `stages[].auto` 子段上的子专项改挂一级段并删掉该子段，迁移前 `VACUUM INTO` 备份，`--migrate` 打印前后行数/段数/子专项数；`stages[].auto` 退化为历史字段 |
