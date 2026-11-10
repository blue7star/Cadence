# MOD-server-api · 同步、动作接口与可见性

paths: server.js

## 职责
`/api/sync` 增量提交、六个动作接口（accept/dispatch/join/toggle/due/notice-seen）的各自判权，以及 `stateFor()` 可见范围。

## 公开行为
- `/api/sync`：`{me, tasks[], rules[], cats[], watch[], del}` → `{ok, rows, errors[], rev}`。
- 六个动作接口见 `DEVELOPMENT.md` §4，各自判权（走不了 sync 的归属校验）。
- 认证：`/api/login`（工号+密码，失败文案统一「工号或密码不正确」，同「工号+IP」5 次锁 5 分钟）、`/api/logout`、`/api/password`（改密后吊销本人其它会话）、`/api/admin/initial-passwords`、`/api/admin/reset-password`（仅 `auth.admin_no`）。
- 导出：`GET /api/export/tasks.csv`，无参数，只导会话本人直接负责/已承接的常规与专项；一行一阶段，UTF-8 BOM + `\r\n`。

## 不变量
- **身份只来自会话**：所有接口先过 `sid` cookie 的会话门，`me` 与会话不符 403、无会话 401；不接受「按请求里的 me 当身份」。导出因此没有「导别人」的口子。
- **停用即失效**：会话门每次都查 `emp.active`，停用（`active=0`）当场 401 并吊销该工号全部会话；不再有「停用后旧 cookie 还能用满 30 天」的窗口。
- **sync 只接受 `owner_no=我` 的行**；请求缺的字段沿用库值；`errors` 非空前端必须原话告诉人。
- 接收看 `assignee_no`、派发与改截止看 `owner_no`/`publisher_no`、加入待办与勾选看 `stages[].who`（须已派发）。**勾选只认这一段的责任人**；承接人对别人负责的段只读，`who` 为空（承接人自己做）时才由承接人勾。
- **可见性五来源**缺一即「派完就断线」：我名下 ∪ 指派给我 ∪ 我发布 ∪ 下属常规/专项 ∪ 我负责某段（须 `whoAt` 非空）∪ 我作为知情人（只读）。子任务责任人挂在 `stages` JSON，SQL 过滤不到，整表取回再筛。
- **接收 = 所有权转移**（`owner_no` 变承接人、`type` 变 `special`），不派生副本；`publisher_no` 永不改。
- 派发对象必须 `activated=1`；生成 temp 必须带 `stage_ref` 反指且幂等。**`stage_ref` 只由服务端在 `/api/stage/join` 写入**：`/api/sync` 收到的 `stageRef` 一律丢弃（落库为 `null`），客户端造不出副本。
- **完成态只有一条上行通道**：派生副本 status 变化 → 回写父任务 `stages[i].done/doneBy`、按叶子重算父任务 status、写 `stage_notice(kind=stage_done)`。不做反向下写（上级侧改动不碰副本）。回写前校验副本 `owner_no` 等于该段 `who` 且 `whoAt` 非空，换人后的旧副本、伪造副本都无效。
- **已派给别人的叶子，完成态以库为准**：非责任人整段提交（哪怕是旧快照）不得覆盖 `done/doneBy/doneAt`；换人（`who` 变了）不算覆盖，新责任人从「未完成」开始，旧副本由服务端收走（段被移除同理）。
- 有子任务的任务，status 由叶子推：全部完成才是 `done`，一段没勾不许挂 `done`；`paused` 与手选的 `doing` 保留（执行人自己的节奏），只有不该成立的 `done` 会被掰回。

## 依赖与边界
- 依赖 `MOD-server-data`。
- 禁止：把接收与派发合并成一个动作（曾合并，后果是「活还没立项就先催人」）。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-subtask-upstream | 见 git | — | 子任务完成上行汇总；勾选判权收紧到责任人；旧快照不得覆盖他人完成态 |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths: server.js`：模块归属由蓝图声明，M1 不再按文件名猜 |
| TASK-20261110-auth-export | 见 git | — | 认证（login/logout/password/超管重置）与会话门；导出 `/api/export/tasks.csv`；会话门加 `emp.active` 校验（停用即失效，并清该工号会话） |
