# Task Contract — TASK-20261117-admin-fixed-password

## 元信息

task_id: TASK-20261117-admin-fixed-password
contract_version: 1
base_revision: 06e7005
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, server-data, tooling, version
sibling_tasks: TASK-20261117-stage-top-who
blueprint_impact: required
parallel_group: none

## 受理（M8）

requirement_quote: 「为啥每次重启哟啊换一个密码，定好了，就是123456」

user_problem: 管理账号 admin 没有口令时随机生成 12 位密码打到启动日志；只要 `must_change=1` 没被清掉，每次重启都会重新生成，导致密码每次重启都变。用户只想要固定初始口令 `123456`，且自己改过密码后重启必须保持改后的那个，不能被重置回 123456。

out_of_scope: 不改员工初始密码（仍为工号）；不改 admin 首次登录强制改密规则；不改改密接口与会话门；不把 123456 写进任何文档、README 或配置样例（只作为代码里的初始口令常量与启动日志提示）；不迁移、不清空已有 admin 会话；不新增环境变量。

acceptance_command: node _dev/verify.mjs --full（期望退出码 0）

stop_conditions: ① 固定初始口令必须允许 admin 在首次登录后改成任意密码并长期保留，任何实现若在 `must_change=0` 时仍写库即停；② 若必须把明文 123456 写进文档/配置样例才能实现即停；③ 若需要改员工口令或会话门才能实现即停；④ 若无法给出「重启前后一致」和「改密后重启保留新密码」两条机器证据即停。

## 目标与范围

- 业务目标与用户可见的成功：
  - 首次部署或 `must_change=1` 时，admin 初始口令固定为 `123456`；启动日志打印这一固定口令，重启前后完全一致，不再轮换。
  - 用户在页面上改过 admin 密码后（`must_change=0`），重启保持新密码：既不再打印初始口令，也绝不把库里的哈希重置回 123456。
  - 首次登录仍然强制改密（沿用既有 403 门与 `must_change`）。
- 范围内：
  - `server.js`：删除 `ADMIN_FIRST_PWD` 的随机生成分支，改为常量 `ADMIN_INITIAL_PWD = '123456'`；`must_change=1`（含行不存在）时 `setAdminPassword('123456', true)`（幂等）；`must_change=0` 时直接返回空串、不写库。
  - 启动日志改为「初始密码固定为：123456 / 重启不会换密码；登录后请及时改密，改过之后重启也不会重置」。
  - `_dev/verify.mjs`：把「未改密时重启 → 换新密码、旧密码作废」的旧断言改为「两次启动都打印 123456、旧密码仍可登录、仍要求改密」；保留「改密后重启 → 新密码可登录、旧密码失效、不再打印」。
  - `specs/modules/server-api.md` 管理账号条目、`server-data.md` 的 `admin_auth` 口径、`tooling.md` 验证口径、`version.md` 版本记录同步；`version.js` 0.13.0。
- 范围外：见元信息 `out_of_scope`。
- 受影响的事实归属者与契约：`specs/modules/server-api.md`（admin 身份与初始口令）、`specs/modules/server-data.md`（`admin_auth`）、`specs/modules/tooling.md`（verify 断言）、`specs/modules/version.md`（0.13.0）。

## 状态表（admin 初始口令）

| # | `admin_auth` 状态 | 启动时行为 | 结果 |
| --- | --- | --- | --- |
| A1 | 行不存在 | `setAdminPassword('123456', true)` | 库里有 123456 的哈希；日志打印固定口令；首次登录强制改密 |
| A2 | 行在、`must_change=1` | 同上（幂等覆盖） | 重启前后都是 123456；日志仍打印固定口令；不会变成随机值 |
| A3 | 行在、`must_change=0` | 什么都不做 | 保留用户改后的密码；不打印初始口令；重启不重置 |

## 风险与权限

- 风险理由：改动认证口令的来源与启动写库分支，属于 G2「身份与可见性」范围；写错会在重启时覆盖用户密码。
- Human 已决策事项：固定初始口令 `123456`；重启不轮换；改密后重启保持用户密码。
- Worker 不得自行决定的事项：把初始口令改成别的值；在 `must_change=0` 时写库；改员工初始密码或会话门；把明文口令写进文档/配置样例。
- 允许的工作区与破坏性操作：只改 `server.js`、`_dev/verify.mjs`、`version.js`、`CHANGELOG.md`、四份蓝图、`DEVELOPMENT.md`（如涉及）与本 run 目录；不 `--no-verify`；不做破坏性 git 操作；验证只在 `_dev/.test-db/` 副本上跑。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出 0；提交后 `python .agents/gates/gate.py --ci --repo .` 输出 PASS。
- 重启一致性（机器证据）：未改密时连续启动两次，`grabPwd` 两次都拿到 `123456`；用第一次的密码登录仍然成功，且 `mustChange=true`。
- 改密后保留（机器证据）：首次登录后改成 `Admin-E2e-2026` → 杀进程重启 → 新密码可登录、旧密码 123456 失效、启动日志不再打印初始口令。
- 反向证据：`must_change=0` 时启动不写 `admin_auth`（哈希前后一致，可在测试库里比对 `changed_at`）。
- 安全与数据：库里只存 scrypt 哈希；明文 123456 不写入任何文档、配置样例或提交内容（代码常量与启动日志除外，属于实现本身）。
- 回滚：回退代码即可；已写入的 123456 哈希可被旧代码读取（哈希格式未变）。
