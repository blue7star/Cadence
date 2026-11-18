# 交付说明 — 临时任务完成日期（v0.14.0）

task_id: TASK-20261118-temp-done-date
contract: v1

## 做了什么

1. `server.js`：`task` 表新增 `done_at TEXT`（`CREATE TABLE` + `ensureColumn`，老库直接可用）。
2. `upsertTask`：无阶段任务（临时任务）在状态迁移时维护完成日期——
   - `todo/doing/paused → done`：写服务端当天 `todayStr()`；
   - `done → done`（改标题等）：保留第一次的值；
   - `done → 非 done`：置 `NULL`；
   - 客户端提交的任何完成日期一律不读（请求体里没有这个字段的入口）。
   `UPDATE` / `INSERT` 的列名与参数成对补齐。
3. 导出 `/api/export/tasks.csv`：第 14 列「完成日期」对无阶段任务改读 `r.done_at`；有阶段任务仍取叶子阶段 `doneAt` 最大值；存量已完成但 `done_at IS NULL` 的行输出空。
4. `_dev/e2e.mjs`：新增四条断言——完成落库且导出一致、取消完成库与导出都清空、直接构造的存量已完成行导出留空、原有「有阶段取叶子 doneAt」回归保留。
5. 文档：`specs/modules/server-api.md`（sync 口径 + 导出第 14 列）、`server-data.md`（`task.done_at`）、`tooling.md`、`version.md`、`DEVELOPMENT.md` §5；版本 0.14.0（新能力 → Y）。
6. 补数方案：`backfill-plan.md`（只给方案与 SQL，未执行，等用户确认）。

## 状态表（与契约一致）

| # | 状态变化 | `done_at` | 导出「完成日期」 |
| --- | --- | --- | --- |
| D1 | 新建成未完成 | `NULL` | 空 |
| D2 | 未完成 → 已完成 | `todayStr()` | 等于 `done_at` |
| D3 | 已完成 → 已完成（改标题等） | 保留第一次的值 | 等于 `done_at` |
| D4 | 已完成 → 未完成 | `NULL` | 空 |
| D5 | 存量已完成、`done_at` 为空 | 不写（禁止补假日期） | 空 |

## 验证

- `node _dev/verify.mjs --full`：13/13 全绿，e2e 286 项（上一版 282 项 + 本任务 4 项）。
- 新增断言：
  - 「临时任务标记完成：服务端把完成日期落在任务上」（DB `done_at` 为 `YYYY-MM-DD`）；
  - 「导出：临时任务完成日期输出到「完成日期」列」（导出值与 DB 同值）；
  - 「取消完成：完成日期跟着清空，不留脏数据」（DB 为 `NULL`、导出为空）；
  - 「存量已完成临时任务没有完成日期：导出留空，不补假日期」。
- 回归：有阶段任务「完成日期取叶子 doneAt」的既有断言保持通过。
- 验证只在 `_dev/.test-db/` 副本上跑；真实库 `data/workbench.db` 未被本次验证修改。
- 真实导出证据：在真实库副本上建一条临时任务 → 完成 → 调 `/api/export/tasks.csv`，实得行见汇报（副本用完即删）。

## 已知影响

- 升级前已完成的临时任务该列为空，这是有意为之：没有可靠的历史完成日期来源，不拿 `updated_at` 或当前时间顶替。
- 补数需用户先确认 `backfill-plan.md` 中的方案（推荐方案 A：不补）；本任务未执行任何补数。
- 有阶段任务的完成日期口径未变。
