# MOD-server-api · 同步、动作接口与可见性

paths: server.js

## 职责
`/api/sync` 增量提交、六个动作接口（accept/dispatch/join/toggle/due/notice-seen）的各自判权，以及 `stateFor()` 可见范围。

## 公开行为
- `/api/sync`：`{me, tasks[], rules[], cats[], watch[], del}` → `{ok, rows, errors[], rev}`。
- 六个动作接口见 `DEVELOPMENT.md` §4，各自判权（走不了 sync 的归属校验）。
- 认证：`/api/login`（工号+密码，失败文案统一「工号或密码不正确」，同「工号+IP」5 次锁 5 分钟；管理账号 `admin` 走同入口的独立分支）、`/api/logout`、`/api/password`（改密后吊销本人其它会话）、`/api/admin/initial-passwords`、`/api/admin/reset-password`、`/api/admin/sessions`（后三个仅管理账号）。
- 导出：`GET /api/export/tasks.csv`，无参数，只导会话本人直接负责/已承接的常规与专项；一行一阶段，UTF-8 BOM + `\r\n`。

## 不变量
- **身份只来自会话**：所有接口先过 `sid` cookie 的会话门，`me` 与会话不符 403、无会话 401；不接受「按请求里的 me 当身份」。导出因此没有「导别人」的口子。
- **停用即失效**：会话门每次都查 `emp.active`，停用（`active=0`）当场 401 并吊销该工号全部会话；不再有「停用后旧 cookie 还能用满 30 天」的窗口。
- **初始密码名单 = 仍在用初始密码的在职员工**：`cred.initial=1`，外加从没登录过、连 `cred` 行都还没有的人（密码同样是工号）；从未登录时 `firstLoginAt` 为空。
- **管理账号是独立身份**：`admin` 走 `/api/login` 的独立分支，会话门不查 `emp.active`，改查 `admin_auth` 是否还在；它不进花名册、不参与业务数据，改密前除 `/api/password`、`/api/logout` 外一律 403。
- **sync 只接受 `owner_no=我` 的行**；请求缺的字段沿用库值；`errors` 非空前端必须原话告诉人。
- 接收看 `assignee_no`、派发与改截止看 `owner_no`/`publisher_no`、加入待办与勾选看 `stages[].who`（须已派发）。**勾选只认这一段的责任人**；承接人对别人负责的段只读，`who` 为空（承接人自己做）时才由承接人勾。
- **可见性五来源**缺一即「派完就断线」：我名下 ∪ 指派给我 ∪ 我发布 ∪ 下属常规/专项 ∪ 我负责某段（须 `whoAt` 非空）∪ 我作为知情人（只读）。子任务责任人挂在 `stages` JSON，SQL 过滤不到，整表取回再筛。
- **接收 = 所有权转移**（`owner_no` 变承接人、`type` 变 `special`），不派生副本；`publisher_no` 永不改。
- **完成态只有一条上行通道**：派生副本 status 变化 → 回写父任务 `stages[i].done/doneBy`、按叶子重算父任务 status、写 `stage_notice(kind=stage_done)`。不做反向下写（上级侧改动不碰副本）。回写前校验副本 `owner_no` 等于该段 `who` 且 `whoAt` 非空，换人后的旧副本、伪造副本都无效。
- **阶段区间是「计划」，判定在服务端**（`upsertTask` → `checkStageIntervals`，只对 `assign`/`special`；routine 的 stages 是当天节点，不按区间判）：
  - `INV-1 同层阶段区间不得相交`。闭区间；首尾相接（前一段到 11-06、后一段 11-07 起）合法；同一段自身不参与配对。拒绝点：`checkStageIntervals` ①；反例：e2e 6.9「压到中间段」「压到最后段」、直调 `/api/sync` 塞重叠段。
  - `INV-2 子阶段必须落在父阶段窗口内`（可等于边界）。拒绝点：`checkStageIntervals` ②（文案「超出所属阶段」）；反例：e2e 6.9「直调 /api/sync 塞子任务到父阶段窗口外」。
  - `INV-3 任务周期等于一级阶段的包络`（最早开始 → 最晚结束）。拒绝点：`checkStageIntervals` ③（文案「任务周期必须等于阶段包络」）；反例：e2e 6.9「直调 sync 让任务周期短于阶段包络」。
  - `INV-4 due ≥ 最晚阶段结束日`。拒绝点：`upsertTask` 的 `t.end > due_date`（`INV-3` 保证 `t.end` 就是包络）；反例：e2e 8.x 超截止。
  - 只判「这次写入改变了阶段区间」的请求：存量里的历史脏数据不挡改标题这类无关编辑；同一类判断前端也有一份，前端只负责当场提示，服务端才是判定者。

## 依赖与边界
- 依赖 `MOD-server-data`。
- 禁止：把接收与派发合并成一个动作（曾合并，后果是「活还没立项就先催人」）。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-subtask-upstream | 见 git | — | 子任务完成上行汇总；勾选判权收紧到责任人；旧快照不得覆盖他人完成态 |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths: server.js`：模块归属由蓝图声明，M1 不再按文件名猜 |
| TASK-20261110-auth-export | 见 git | — | 认证（login/logout/password/管理账号重置）与会话门；导出 `/api/export/tasks.csv`；会话门加 `emp.active` 校验（停用即失效，并清该工号会话）；初始密码名单口径改为「仍在用初始密码的全部在职员工」，含从没登录、尚无 cred 行的人；管理账号改名为独立 `admin`（分表、不进 emp、首登强制改密），新增 `/api/admin/sessions` |
| TASK-20261111-stage-interval | 见 git | — | `upsertTask` 新增 `checkStageIntervals`：同层区间不相交（首尾相接合法）、子阶段在父窗口内、任务周期等于一级阶段包络；只判本次写入改变区间的请求，通过后把周期收敛到包络；INV-1~INV-4 落地 |
| TASK-20261112-rules-dedup | 见 git | — | 删除 4 条已被代码覆盖的公开行为（登录失败计数上限、派发 activated/stage_ref 独占、已派发叶子完成态以库为准、status 由叶子推）；INV-1~INV-4 保留为规范来源 |
