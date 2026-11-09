task_id: TASK-20261109-subtask-upstream
contract_version: 1
candidate_revision: 1
candidate_digest: 2d947b33d3a53451f05c909e109b0c75dee634c3c7d1cc51c19d6a883eff113d
base_revision: 5a523476827f8fadf58f8245079443df1b9636b1
reviewer: 独立子代理
reviewer_context: reviewer-subagent-20261109
worker_context: 6af130d07cf2c26848cc987d
attempt: 1
verdict: FAIL_IMPLEMENTATION
max_severity: P1
evidence_status: PARTIAL
not_run_count: 1
supersedes: none

## 独立性

未参与实现，也未采信交付说明中的结论。判断只基于：① 仓库工作区 `git diff` 的代码；② `server.js` / `public/app.js` 的完整上下文；③ 我自己在 http://127.0.0.1:8799 上用自建任务 id（`rv_ups_1`、`rv_ps_1`、`rv_orph_1`、`rv_forge_1`）打接口得到的响应与 `/api/state` 回读；④ 本地库只读查询；⑤ 我自己跑的 e2e 与 `verify.mjs`。全程未访问 172.17.0.85，未改任何代码、配置或数据库结构；测试数据已清理（含把自建任务产生的提醒标已读）。

实现方四条主口径的主干是成立的：责任人勾完成能上行到上级、上级与第三人调 toggle 被拒、旧快照改标题冲不掉完成态、上级改计划不反写副本，这四条我都亲手复现为通过。判 FAIL 是因为新增的上行通道本身缺判权，且两条新写进蓝图的不变量在代码里不成立。

## Findings

| ID | Severity | Class | Evidence | Required route |
|---|---|---|---|---|
| F1 | P1 | permission_bypass / data_integrity | `pullStageFromMirror()` 只按 `stage_ref` 里的 `{taskId,stageId}` 回写，不校验 `mirror.owner_no === stage.who`、不校验 `whoAt`、不校验这条副本是否真由 `joinStage()` 生成。实测：1004 用 `/api/sync` 新建 `rv_forge_1`（type=temp，`stageRef={taskId:'rv_ups_1',stageId:'rc2'}`，status=done），父任务 rc2 立刻变成 `done=true`、`doneBy=1004`，而该段 `who=1005`、`whoAt` 为空、从未派发，父任务 status 被推到 `done`，上级还收到“王浩完成了…”的 `stage_done` 假提醒。这同时击穿“非责任人不能勾”“未派发不能勾”两条验收，且不需要冒用 `me`。 | 在 `pullStageFromMirror` 里加三道校验：`mirror.owner_no === s.who`、`s.whoAt` 非空、该副本确实由 `joinStage` 生成（校验 `joinedAt` 或 `st_<taskId>_<stageId>` 规则）；不满足直接忽略并记一条异常日志。 |
| F2 | P2 | permission_bypass | `keepForeignDone()` 只按 `prev` 里已存在的 `id` 保护，新增叶子不在保护集。实测：承接人 1012 整段提交时新增 `rcnew`（`who=1005`、`done=true`），落库为 `done=true`、`doneBy=1012`、`whoAt` 为空 —— 等于用“新增即完成”绕过“上级不能代勾”。界面新建节点固定 `done:false`，属接口层可复现、界面不会自然触发。 | 新增叶子里若 `who` 非空且 `who !== meNo`，强制 `done=false/doneBy=null/doneAt=null`；与 `keepForeignDone` 同一处收口。 |
| F3 | P2 | state_inconsistency | 换人不重置完成态：把已完成的 rc1 从 `who=1003` 改成 `1005`，结果是 `who=1005`、`whoAt=空`、`done=true`、`doneBy=1003`。新责任人未派发时不能勾，旧副本还留在库里且仍能写回：1003 把自己那条 `st_rv_ups_1_rc1` 改成 doing 后，rc1（此时归 1005）被拉回 `done=false`、`doneBy` 清空。这与 `specs/modules/server-api.md` 本次新增的不变量“换人…新责任人从「未完成」开始”直接矛盾（`keepForeignDone` 的注释也这么写，但 `applyStageOwners` 的换人分支只清 `whoAt/joinedAt`，没有清 `done`）。 | 在 `applyStageOwners` 的 `p.who !== o.who` 分支强制 `done=false/doneBy=null/doneAt=null`；换人或父任务移除该段时，把对应 `stage_ref` 副本删除或标记失效，否则旧副本会继续写别人的段。 |
| F4 | P2 | behavior_regression | `stageStatusFromLeaves()` 在“有子任务”时无条件覆盖人工状态：0 个叶子完成 → `todo`、全部完成 → `done`，只有“部分完成”才保留 `paused`。实测：新建专项（1 个阶段 + 1 个叶子、0 完成、提交 `status=paused`），落库后回读 `status=todo`。这超出验收范围（验收只要求“未全完成不出现 done”），也与 `server-api.md` 新增的“`paused` 保留”矛盾，用户手选“暂缓”会被静默改回“待办”。 | 只介入两个方向：全部完成 → `done`、从 `done` 退回；不要覆盖用户手选的 `paused/doing`。若坚持由叶子完全决定，就同步改文档并在 UI 里拿掉会失效的选项。 |
| F5 | P3 | testcase_gap | 9.11 清理只对 1003 调 `/api/notice/seen`，父任务 1012 的 `stage_done` 提醒留在库里（我跑完一轮实测仍有 1 条 `kind=stage_done`，而 `t_e2e_upstream` 已删除）。于是下一轮 `doneNotice >= 1` 会被上一轮残留直接满足，正向提醒断言失去含义；这与交付说明“两处清理把提醒标已读，避免跨轮污染”不完全一致。“承接台显示「完成」”只断言了 API 的 `kind`，没有断言 UI 标签；“上级改计划”只测了改标题，没测真正改日期。 | 9.11 收尾同时给 1012 标已读；把提醒断言改成“先清空再计数”的精确值；补一条改 date 的断言和一条承接台“完成”标签的 UI 断言。 |
| F6 | P3 | ux_gap / orphan_data | 未派发的叶子双方都不能勾（`whoAt` 为空时承接人也被拒），派发前任务无法推进；同时派生副本删除了删除按钮，父任务把该段移除后副本仍在：实测父任务删掉 oc1 后，1004 的 `st_rv_orph_1_oc1` 仍存在（`pruneOrphans` 不清理 `stage_ref` 孤儿），当事人无法自删。 | 明确“未派发时谁勾”的产品口径（建议承接人可勾，或允许责任人勾）；父任务移除/换人段时清理或失效对应副本；若要保留只读口径，至少给责任人一个移除入口。 |

## 证据重建与残余风险

实际运行（全部在 d:\ai_project\ai_work\Cadence，服务 http://127.0.0.1:8799）：

- `git diff --stat` / `git diff -- server.js public/app.js _dev/e2e.mjs specs/...`：改动集中在契约声明的 5 个代码/文档面 + 3 份归档契约各 1 行摘要；未见改表结构、未见改 `/api/sync` 请求/响应形状。
- 自建数据 `rv_ups_1`（special，阶段 p1，叶子 rc1→1003、rc2 初始无 who）：派发后
  - `1003` 调 `/api/stage/toggle` → `{ok:true,done:true}`；上级 `/api/state?me=1012` 回读 `rc1.done=true`、`doneBy=1003`、`status=doing`、`notices` 出现 `stage_done`。**通过**。
  - `1012` 调 toggle → `{ok:false,"这一段由别人负责，只有他能勾完成"}`；`1004` 调 toggle → 同样被拒。**通过**。
  - `1012` 用 `done=false` 的旧快照提交并夹带 `status=done` → 标题落库、`rc1.done=true`、`doneBy=1003`、任务 `status=doing`。**通过**。
  - `1003` 改副本 status=doing → 父任务 `rc1.done=false`、`status=todo`；再改 done → `rc1.done=true`、`doneBy=1003`、`status=doing`。上行通道方向正确、无循环。**通过**。
  - 上级改计划后副本 status 未被翻动（e2e 断言 `mirror=done`；代码上 `syncMirrorStatus` 只在 `who===me` 时调用）。**通过**。
- 反向绕权（自建）：`1004` 用 `/api/sync` 伪造 `stageRef` → F1；承接人整段提交新增 `done=true` 叶子 → F2；换人 → F3；`status=paused` 落库变 `todo` → F4；移除阶段后副本残留 → F6。均附在 Findings 的具体字段值里。
- `node _dev/e2e.mjs http://127.0.0.1:8799`：`PASS 160 / FAIL 0`，退出码 0；9.11 的 9 条断言逐条打印为 PASS（含“上级详情页无代勾入口 `aTick:false,bTick:true`”“上级/第三人被拒”“`doneBy:1003,status:doing,doneNotice:1`”“计数 1 / 2”“旧快照后 status=doing”“mirror=done”）。
- `CADENCE_NO_REPORT=1 CADENCE_BASE=http://127.0.0.1:8799 node _dev/verify.mjs --full`：7 项全绿，退出码 0（语法、版本 v0.8.5、CHANGELOG 一致、契约状态、门禁反面用例、服务版本一致、e2e 160 项）。以 `--fast` 单跑时树摘要为 `79ad2e5afa74f3cd`（含我未提交的 `artifacts/`）。
- 本地库只读查询（`node:sqlite`，readOnly）：`stage_ref` 非空任务 1 条，`normal=1`、`gap=0`、`orphan_ref=0` —— 与交付说明“存量补数清单 0 条、未落库”一致；但 F6 说明“孤儿副本”这类数据不在这条查询口径内。
- 与实现方证据的差异：① 交付说“两处清理把提醒标已读”，实测父任务 1012 仍留 1 条 `stage_done`（F5）；② 交付说“9.11 共 9 条断言覆盖正反向”，覆盖基本属实，但提醒断言会被上一轮残留满足，且“改期”只测了改标题；③ 交付未提 F1–F4 任何一条。
- 范围检查：未见超范围改动；唯一越界的行为变化是 F4（有子任务时人工 `paused/doing` 被重算覆盖），以及 3 份归档契约各改 1 行摘要（文档，无运行影响）。
- 残余风险：本仓 `me` 由请求体自带、无会话令牌，整个判权模型是“诚实客户端 + 接口层兜底”。F1/F2 是在**不冒用他人 `me`** 的前提下打穿“只有责任人能完成”，因此不因该模型而免责；生产实例 172.17.0.85 按契约禁止访问，其存量数据未核。

NOT_RUN（1 条）：

1. `python .agents/gates/gate.py --ci --repo .` —— 未跑。该门禁的 M2/M6 依赖独立 Reviewer 的 PASS 事件，本次结论是 FAIL_IMPLEMENTATION，跑也只会得到预期的红；同时避免它在 `.agents/gates/` 下写产物、污染待复核的这棵树。

## 判定理由

四条 Human 口径的主路径确实修好了，界面侧“上级看别人那段没有勾选框”、副本只留完成情况、承接台“完成”标签也与后端判权一致，e2e 与 `verify --full` 全绿。但“绿”只证明它测到的路径对，不能证明新开的通道没洞。

判 FAIL_IMPLEMENTATION 的直接依据是 F1：本次新增的唯一条上行通道 `pullStageFromMirror` 对来源不做任何身份校验，任何登录用户都能用 `/api/sync` 造一条带 `stage_ref` 的 temp 把别人（甚至未派发）的子任务标成完成、把父任务推成 done，并给上级发一条假提醒。这正面违反契约验收里的“反向 B：非责任人勾 → 被拒”，也违反本仓自己写在动作接口上的“绕过界面直接打接口也拦得住”。F2 是同一类判权洞的另一入口，F3/F4 则是本次新写进 `server-api.md` 的两条不变量（“换人后新责任人从未完成开始”“paused 保留”）在代码里并不成立，属实现与蓝图不一致，不是文档笔误。

数值上：P1 1 条、P2 3 条、P3 2 条。修完 F1/F2/F3/F4 并补上 F5 的隔离断言后，可以走下一轮复核；F6 可与产品口径一起定。
