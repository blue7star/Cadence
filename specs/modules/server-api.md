# MOD-server-api · 同步、动作接口与可见性

## 职责
`/api/sync` 增量提交、六个动作接口（accept/dispatch/join/toggle/due/notice-seen）的各自判权，以及 `stateFor()` 可见范围。

## 公开行为
- `/api/sync`：`{me, tasks[], rules[], cats[], watch[], del}` → `{ok, rows, errors[], rev}`。
- 六个动作接口见 `DEVELOPMENT.md` §4，各自判权（走不了 sync 的归属校验）。

## 不变量
- **sync 只接受 `owner_no=我` 的行**；请求缺的字段沿用库值；`errors` 非空前端必须原话告诉人。
- 接收看 `assignee_no`、派发与改截止看 `owner_no`/`publisher_no`、加入待办与勾选看 `stages[].who`（须已派发）。
- **可见性五来源**缺一即「派完就断线」：我名下 ∪ 指派给我 ∪ 我发布 ∪ 下属常规/专项 ∪ 我负责某段（须 `whoAt` 非空）∪ 我作为知情人（只读）。子任务责任人挂在 `stages` JSON，SQL 过滤不到，整表取回再筛。
- **接收 = 所有权转移**（`owner_no` 变承接人、`type` 变 `special`），不派生副本；`publisher_no` 永不改。
- 派发对象必须 `activated=1`；生成 temp 必须带 `stage_ref` 反指且幂等。
- 后写覆盖（已知边界）。

## 依赖与边界
- 依赖 `MOD-server-data`。
- 禁止：把接收与派发合并成一个动作（曾合并，后果是「活还没立项就先催人」）。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
