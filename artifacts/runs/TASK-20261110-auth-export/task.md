# Task Contract — TASK-20261110-auth-export

> 第一批：认证 + 导出。第二批 `TASK-20261110-task-import`（导入）只在本契约的「范围外」和 `sibling_tasks` 里出现，**本批不实现**。
> 需求规格：`specs/features/auth-and-transfer.md`（口径已确认：状态四值、分类 ID 列、`detached=1`、完成日期只读、e2e 计入本批工作量）。

## 元信息

task_id: TASK-20261110-auth-export
contract_version: 2
base_revision: 41b9ae2
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, server-data, app-ui, tooling, version
sibling_tasks: TASK-20261110-task-import
blueprint_impact: required
parallel_group: none

## 受理

> **口径变更（2026-11-11，cv2）**：原第 4 项「超管 = 花名册里的 005822 / `meta.auth.admin_no` / `CADENCE_ADMIN_NO`」已被用户否决，改为独立管理账号 `admin`（独立 `admin_auth` 表，不占工号、不进 `emp`；首次启动随机生成初始密码、只打印一次；首次登录强制改密；不读环境变量）。`requirement_quote` 保留用户原话，不改写。同轮追加：发版 `version.js` 也归本契约（`modules` 增 `version`）。
>
> **读法（cv3）**：本文后文凡写「超管」「`auth.admin_no`」「可配置的超管」之处，一律按上面的独立管理账号 `admin` 理解；`out_of_scope` 里「只新增 cred 与 sess 两张表」相应放宽为「cred / sess / admin_auth 三张表」。其余条款不动。

requirement_quote: 初始密码 = 本人工号，登录页给提示；登录后用户可自助改密（不做强制首登改密）。重置密码只有**超管一人**（用户本人 005822 之外再加一个可配置的 `auth.admin_no`，默认指向他）。不做上级重置链。状态枚举取**四值**（待办/进行中/已完成/暂缓），导出导入都按四值处理，不许降级合并。
user_problem: 工作台现在只凭「工号 + 姓名」登录，同事之间只要知道姓名就能冒用对方身份查看和改动任务，离职或工号外泄后也没有任何收口手段；管理者手上近八百条任务只存在于界面里，换机、备份、线下整理、交给别人接手都没有出口。
out_of_scope: 本批不做导入、不做文件上传与预览、不做 TLS 与反代、不做 Secure cookie、不做密码复杂度策略与找回密码、不做上级重置链、不做权限分级（超管之外仍平权）、不做 xlsx 与 JSON 格式、不导规则与分类树与知情人名单、不改 task 表结构（只新增 cred 与 sess 两张表）。
acceptance_command: node _dev/verify.mjs --full（自起 8799 测试库副本实例，跑完收摊；期望退出码 0）
stop_conditions: 出现以下任一情况立刻停下问人：需要修改 task 表结构或既有列语义；需要把 cookie 设为 Secure 或在 http 下强制扫码登录；需要引入新的 npm 依赖（本项目零依赖，含 cookie jar 库）；005822 或 CADENCE_ADMIN_NO 指向的工号在花名册里不存在且无法确定超管；e2e 改造超出「登录助手 + cookie 透传」的范围；导出文件需要声明 v2 或更高格式版本。

## 目标与范围

- 业务目标与用户可见的成功：
  - 打开工作台先看到登录页，输入工号 + 密码才能进入；初始密码就是工号，页面上有提示。
  - 登录后可自己改密码；超管（`auth.admin_no`）能把某人的密码重置回工号，并看到「谁还在用初始密码」及首次登录时间/IP。
  - 任何没有会话的接口调用返回 401，前端回登录页；请求里带别人的 `me` 不再生效。
  - 「导出我的任务」得到一个 UTF-8 BOM 的 CSV，Excel 双击能看，一行一阶段、任务级列只在首行，人能读、机器能原样回灌。
- 范围内（in scope）：
  - `cred`、`sess` 两张新表 + 启动时幂等生成初始密码（scrypt）。
  - 登录 / 退出 / 改密 / 超管重置 / 初始密码名单五个接口；全站会话绑定与 401、`me ≡ session.no`。
  - 失败 5 次锁 5 分钟（按工号 + IP）；登录错误文案合并，不再区分「工号不存在」与「密码错」。
  - `GET /api/export/tasks.csv`：范围、列定义、BOM、一行一阶段与续行规则、转义按 `specs/features/auth-and-transfer.md` §4。
  - 前端：登录页提示、改密入口、超管入口、导出按钮、401 处理。
  - `_dev/e2e.mjs` 改造：每个身份先登录、cookie 透传；新增认证与导出断言。**这是本批正式工作量（163 项）。**
  - `.agents/SPEC.md` §2「一期不做密码」同步修订；`specs/modules/server-api.md`、`server-data.md`、`app-ui.md`、`tooling.md` 的职责与不变量同步。
- 范围外：见元信息 `out_of_scope`；导入相关的接口、预览、红线判定一律不在本批。
- 已批准的 L0-L2a 决策（Human 已拍板）：
  - 初始密码=工号、不强制首登改密、超管单人重置、登录页不展示工号名单、http 明文与无 Secure 作为已知风险 R1 接受（`specs/features/auth-and-transfer.md` C7）。
  - 状态四值，导出导入都按四值，**不许降级合并**（C13）。
  - 分类主列导名称、末尾补 `分类一ID/分类二ID`；回灌 ID 优先（D2-A）。
  - 导入新建的常规任务写 `detached=1`，语义「导入后的常规任务不跟随规则变化」写入 Spec（D3-A / §4.5）。
  - 「完成日期」导入只读，以阶段完成日为准，不加任务级字段（C3）。
- 受影响的事实归属者与契约：
  - 身份与可见性归 `MOD-server-api`；建表与迁移归 `MOD-server-data`；登录页与导出入口归 `MOD-app-ui`；e2e 与门禁归 `MOD-tooling`。
  - 导出字段定义与续行规则由本批冻结，第二批只消费，不另写一套。

## 风险与权限

- 风险理由（为什么不是 G0）：动的是鉴权与对外接口形状，还新增两张表；错了的后果是「全员进不去」或「加了密码等于没加」。
- Human 已决策事项：初始密码=工号；超管唯一且可配置；不做 TLS、cookie 不加 Secure，风险 R1 由 Human 接受并写入文档；完成时间只到日期，不改数据模型；状态四值；分类 ID 列；导入新建常规任务 `detached=1`。
- Worker 不得自行决定的事项：cookie 名与有效期（`sid`，空闲 8h / 绝对 30d）、锁定时长与判定键、错误文案、导出列顺序与列名、阶段转义规则、是否给 `/api/reset` 与 `/api/demo` 追加超管限制、是否引入任何依赖。
- 允许的工作区与破坏性操作：可新增表、可新建文件；**不得**删改 `data/workbench.db` 里既有任务与花名册（e2e 夹具的测试数据除外）；不得改 `version.js` 语义（版本号按发版流程单独走）。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出码 0；`python .agents/gates/gate.py --ci --repo .` 全 PASS。
- 集成与反向路径（新增 e2e 断言，缺一不算过）：
  - 错误密码 5 次 → 第 6 次提示锁定；正确密码在锁定期内也被拒；5 分钟后恢复。
  - 不带 cookie 调 `/api/state` → 401；带 cookie 但 `me` 是别人 → 403。
  - 非超管调 `/api/admin/reset-password` → 403；超管调 → 目标用户旧会话失效、可用工号重新登录。
  - 改密后旧密码登录失败、新密码成功；本人其它会话被吊销。
  - 导出范围：只包含 `type in (routine,special)` 且 `owner_no=me` 的行；不含 `assign`/`temp`/待接收/仅知情人/仅负责某段的任务。
  - 导出文件：首字节为 BOM；前三行是以 `#` 开头的注释（格式版本 v1、导出人、导出时间）；第四行中文表头；表头列名与集合固定，导入按列名匹配；一行一阶段，任务级列只在任务首行有值，续行任务级列必须为空；无阶段任务占一行且阶段级列全空；文件行数 = 任务数 + 阶段总数（无阶段任务按 1 行计）在测试集上可人工核对。
  - 状态四值原样导出（含 `暂缓`），不合并、不排除。
  - 登录页不出现任何工号列表；超管名单只列 `initial=1` 的人。
- 文档同步（蓝图 / specs）：`.agents/SPEC.md` §2 的「一期不做密码、权限分级」改为已做的边界说明；`specs/features/auth-and-transfer.md` 状态由 DRAFT 改为生效；四个模块蓝图的职责/不变量补会话与导出条目，并各加一行变更历史。
- 安全、数据、迁移与回滚证据（G3 必填，本批按同等标准给）：
  - 老库直接可用：`cred`/`sess` 只在启动时 `CREATE TABLE IF NOT EXISTS`，不重建 `workbench.db`；初始密码批量生成幂等（重启不覆盖已改过的密码）。
  - 回滚：删两张新表 + 还原 `server.js`/`public/` 即可，任务数据零影响；回滚后登录退回工号+姓名。
  - R1 复述：明文 HTTP 下 cookie 可被嗅探，等于身份可被劫持；文档与启动日志都写明「仅限可信内网」。
  - 交付物：`delivery.md` 附 `--full` 与 `gate --ci` 原始输出、导出样例文件路径。
