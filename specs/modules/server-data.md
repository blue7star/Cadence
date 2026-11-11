# MOD-server-data · 数据层与实例引擎

paths: server.js, data/

## 职责
建表（`emp/task/rule/cat/task_observer/stage_notice/watch/op_log/meta/holiday/cred/sess/admin_auth`）与常规实例生成引擎（`ruleSteps` / `cyclesBetween` / `ensureInstances` / `maintain`）。

## 公开行为
- 首次启动自动建表；表结构变更须兼容已有 `data/workbench.db`（`ALTER TABLE` 前先查 `pragma table_info`，加字段给默认值，不改已有列含义）。
- `maintain()` 每次取 state 前按 `today-40d ~ today+80d` 补齐常规实例。

## 不变量
- **实例幂等**：同一 owner + 规则 + 周期只能有一条（`INSERT OR IGNORE`）；重复跑 `maintain` 不产生新行。
- `task` 三列归属：`publisher_no` 永不改、`owner_no` 随接收转移、`due_date` 只有发布人能改。
- 常规只按工作日生成；节假日算法服务端为准。
- **`op_log` 有上限（默认 20000 条）**：超限时只删「不是某人第一条 `login`」的旧行；首次登录时间是初始密码名单的证据，不随日志裁剪消失。
- `INSERT` 列名与 `run()` 参数必须成对改，加列忘补参数只能等运行时炸。
- **密码只存 scrypt 派生值**（`cred.hash` + 每条随机 `salt`），初始密码=工号（`initial=1`），改密后 `initial=0`；`sess` 存 `sid`/`no`/`last_seen`，滑动空闲 8h、绝对 30d。导出全程只读，不回写任何表。
- **管理账号与花名册分表**：`admin_auth(account, hash, salt, must_change, changed_at)`，只有 `admin` 一行，不占工号、不进 `emp`；随机初始密码在 `must_change=1` 期间每次启动重新生成并打印，改密后不再生成，库里只存 scrypt 哈希；`must_change=1` 时除改密/退出外一律 403。业务查询（下属、可见范围、导出、上级校验）只读 `emp`，所以它不会被当成同事。

## 依赖与边界
- 依赖 `node:sqlite`（零第三方）、`version.js`。
- 禁止：前端直接写库；`temp`/`routine` 拉平（无 `pid`）。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths: server.js`：模块归属由蓝图声明 |
| TASK-20261110-auth-export | 见 git | — | 新增 `cred`（scrypt 口令）、`sess`（会话）、`admin_auth`（独立管理账号）三表；导出只读；管理账号不占工号、不进 `emp`，初始密码首次启动随机生成并只打印一次；`op_log` 加条数上限，裁剪只删「不是某人第一条 login」的旧行 |
