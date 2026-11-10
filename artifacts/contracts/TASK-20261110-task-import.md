<!-- 草稿：第一批交付并通过后才 `agent_workflow.py task start`。确认前放 artifacts/contracts/，不要冒充已启动的 run。 -->

# Task Contract — TASK-20261110-task-import

> 第二批：导入。依赖第一批 `TASK-20261110-auth-export` 已交付：会话绑定、导出接口、CSV 字段定义与「一行一阶段」解析器都在那里，本批**只做回灌**，不重写格式。
> 需求规格：`specs/features/auth-and-transfer.md` §4、§5、§7。

## 元信息

task_id: TASK-20261110-task-import
contract_version: 1
base_revision: 41b9ae2
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, app-ui, tooling
sibling_tasks: TASK-20261110-auth-export
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 语义：同任务编号=更新，无编号或编号不存在=新建；写入前先出预览（新增 N / 更新 M / 跳过 K 及原因），确认后才落库。只允许导入自己名下的任务（文件里 owner/承接人必须是本人），否则拒绝——这是防注入的红线。导出与导入共用同一套字段定义与阶段语法，必须能往返一致。
user_problem: 任务只能一条条在界面里点，历史数据、线下整理过的表格、以及从别处搬过来的任务都进不来；管理者想批量修正日期或阶段只能手工改，改错也没法回滚。导出的文件现在只能看，不能改完再灌回去。
out_of_scope: 本批不改认证口径、不改导出格式、不做 xlsx 与 JSON、不做规则（rule）与分类树（cat）的导入、不做知情人/关注/提醒的导入、不允许跨人导入、不自动创建分类、不做增量同步与三方冲突合并、不做导入撤销、不改 task 表结构、不引入任何依赖（含 multipart 解析库）。
acceptance_command: node _dev/verify.mjs --full（前置：第一批已在 8788 端口运行且当前代码已重启；期望退出码 0）
stop_conditions: 出现以下任一情况立刻停下问人：需要绕过 upsertTask 直接写 SQL；需要给 task 表加列；需要引入依赖或手写 multipart；发现第一批导出格式与 specs/features/auth-and-transfer.md 不一致（先修第一批，不在本批兼容旧格式）；C13 的暂缓状态口径仍未确认；任何一行非本人任务的处理方式需要从「整文件拒绝」放宽成「跳过」。

## 目标与范围

- 业务目标与用户可见的成功：把导出的 CSV（可以手改）拖回来，先看到「新增 N / 更新 M / 跳过 K + 每行原因」，点确认后才落库；重复导入同一份文件不产生重复任务；导入别人的任务被明确拒绝。
- 范围内（in scope）：
  - `POST /api/import/preview`、`POST /api/import/apply`，按 `specs/features/auth-and-transfer.md` §5。
  - 严格解析：跳过 `#` 注释行、按列名匹配、按「最近非空任务编号」向下填充、结构错误整文件拒绝并报行号/列名。
  - 任务级判定（新建/更新/跳过）与三条红线（非本人所属人、非本人承接人、编号属于别人）。
  - 落库复用 `upsertTask()`；新建常规任务按 D3 写 `detached=1`；分类按名称/ID 解析，不自动建分类。
  - 前端：选择文件、预览表格、确认落库、错误行号可读。
  - e2e：§7 全部往返与反向用例。
- 范围外：见元信息 `out_of_scope`。
- 已批准的 L0-L2a 决策：D2（分类 ID 列）、D3（新建常规任务 `detached=1`）、D5（补丁式覆盖）、D6（结构错误整文件拒绝、业务错误逐任务跳过）。
- 受影响的事实归属者与契约：接口与判权归 `MOD-server-api`；上传与预览 UI 归 `MOD-app-ui`；e2e 与门禁归 `MOD-tooling`。导出侧的字段定义由第一批拥有，本批只消费。

## 风险与权限

- 风险理由（为什么不是 G0）：写库路径 + 文件解析 + 防越权，任一环错都可能覆盖别人的数据或静默丢字段。
- Human 已决策事项：导入只允许本人任务且越权整文件拒绝；同编号=更新、无编号=新建；预览后才落库；导出与导入同一套字段定义。
- Worker 不得自行决定的事项：结构错误与业务错误的边界；续行规则（R1-R9）的任何放宽；阶段按 id 匹配（不得退回下标兜底）；digest 校验；跳过原因的文案枚举；是否自动建分类。
- 允许的工作区与破坏性操作：可在 e2e 里造/删测试任务；**不得**在开发过程中对 `data/workbench.db` 的真实任务做批量导入；手工验证必须用副本库或测试工号。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出码 0；`python .agents/gates/gate.py --ci --repo .` 全 PASS。
- 集成与反向路径（对应 `specs/features/auth-and-transfer.md` §7，缺一不算过）：
  - 导出 → 不改一个字节 → 导入 → 再导出：任务数、阶段数、`id/name/start/end/who/done/doneAt/pid`、日期、分类、状态全部等价（`更新时间` 与 `完成日期` 按 C3 规则除外）。
  - 续行：把某任务第二行的任务级列填上值 → `400`，报行号。
  - 表头：删必需列 / 加未知列 / 列名重复 → `400`；列序整体打乱 → 结果不变。
  - 红线：所属人=别人、承接人=别人、编号属于别人 → 均 `400` 且库内 `updated_at` 无变化。
  - 预览不落库；digest 不匹配 → `409`；同一文件 apply 两次第二次 `created=0`。
  - 无阶段任务只占一行且能正确回灌为 `stages=[]`。
- 文档同步（蓝图 / specs）：`specs/modules/server-api.md` 增补导入接口与判权；`specs/features/auth-and-transfer.md` 的导入章节若有实现期修订必须回写；变更历史各加一行。
- 安全、数据、迁移与回滚证据（G3 必填，本批按同等标准给）：
  - 不新增表、不改表结构；失败时整文件不落库，库保持导入前状态（用行数与 `updated_at` 证明）。
  - 回滚：移除两个接口与前端入口即可，已导入的数据是正常业务数据，不需要反向迁移。
  - 证据：`delivery.md` 附 `--full` 与 `gate --ci` 原始输出、一份往返前后的 CSV 样例路径、拒绝场景的响应体。
