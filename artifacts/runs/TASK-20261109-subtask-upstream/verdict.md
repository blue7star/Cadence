# Verdict — TASK-20261109-subtask-upstream

## 身份（机器读）

task_id: TASK-20261109-subtask-upstream
contract_version: 1
candidate_revision: 1
candidate_digest: 13e68ce1b90cb1f0d1614cd8c3f5f69b844db897e82edbf4bb3219102aed85b7
base_revision: 5a523476827f8fadf58f8245079443df1b9636b1
reviewer: Reviewer
reviewer_context: reviewer-subagent-20261109-c
worker_context: 6af130d07cf2c26848cc987d
attempt: 3
verdict: PASS
max_severity: P3
evidence_status: COMPLETE
not_run_count: 0
supersedes: 2

## 独立性

- **独立声明**：本轮为独立子代理的新上下文，未参与实现，只依据工作区代码、本地库、`/api/*` 实测、e2e 与 verify 的真实输出取证。`delivery.md` 只当线索，结论逐条自证；上一轮（attempt 2）的 P2 阻塞点与 3 条 P3 均按实测复核，不采信说明文字。
- **本次读取的项目权威**：`AGENTS.md` §2/§4/§5/§6、`.agents/templates/verdict.md`、`.agents/archive/contracts/_template.md`、`specs/modules/server-api.md`、`specs/modules/app-ui.md`、`artifacts/runs/TASK-20261109-subtask-upstream/task.md`、`_dev/verify.mjs`、`_dev/e2e.mjs` 9.11 段。
- **已核对的 Task Contract 与 delivery 摘要**：`in_scope`（子任务完成判权、上行汇总、状态由叶子推、admin/文档同步）未被越过；Human 四条口径（完成只由该段责任人勾 · 上行只走「副本 → 父」 · 上级保留计划类权限 · 不得双向循环）在代码与 specs 里一致；delivery 声明的候选摘要、`not_run: none`、9.11 断言数已逐项对账。
- **候选摘要独立复算**：对 `git diff HEAD` 原始字节做 sha256 = `13e68ce1b90cb1f0d1614cd8c3f5f69b844db897e82edbf4bb3219102aed85b7`，与任务书及 `delivery.md` 一致；`git rev-parse HEAD` = `5a52347…`；`git status` 仅 11 个已跟踪改动 + `?? artifacts/`，工作区无额外漂移。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
| --- | --- | --- | --- | --- |
| RV-5 | P3 | contract_gap | `node _dev/verify.mjs --fast` 退出码 0、5 项全绿，但它打印的**当前树摘要**是 `868a1a14dd96302d`（35 个代码文件 / 31 个文档），与绿报告 `a6030feb9974a28f` 不同。逐文件比对 `_dev/verify-report.json` 的 `each`（66 项）后差异 5 处，全在证据面：`artifacts/…/delivery.md`（改写）、`artifacts/…/verdict.md`（移除，内容原样移成 `evidence/verdict-attempt2-fail.md`，同 hash `8a62b0167356`）、3 份归档契约（复核对象已对齐 `a6030feb`，正文与条数说明随之改写）。即「报告之后的写入会再次移动锚点」这个结构性问题仍在：`contracts()` 比的是**上一份**报告里的 digest，而 `artifacts/` 不在 `verify.mjs` 的 DOC_ONLY 里，任何交付/复核写入都会改变下一轮树摘要。本次未影响实现，`--fast` 与契约检查均判绿。 | 把 `artifacts/` 纳入 `_dev/verify.mjs` 的 DOC_ONLY（或 `.gitignore`），或让 `contracts()` 直接比当前树摘要而非上一份报告——否则每个 PASS 都只能绿一次。超出本任务 `in_scope`，建议在 `.agents/issues.md` 单独立项，不必随本任务返工。 |

上一轮的 3 条 P3 已逐条复验关闭（不构成 finding）：

| 原 finding | 复验结论 |
| --- | --- |
| 手选「进行中」被静默回退 `todo` | **已关闭**。`stageStatusFromLeaves()` 现保留 `paused` 与 `doing`；9 组探针全部符合新口径（新建即 `doing`→`doing`；只改标题→`doing`；手选 `paused`→`paused`；`paused` 下勾一个叶子→仍 `paused`；全完成→`done`；从 `done` 撤一个→`doing`；`doing` 下勾了又撤→`doing`；提交空 `status:''`→`todo`）。本轮 `rv3_up` 另证：派发后 `todo` → 上行完成 → `doing` → 换人后仍 `doing`，未被打回。**`status` 不会变空值**：`upsertTask` 走 `let status = t.status \|\| 'todo'`，有叶子时再由 `stageStatusFromLeaves` 覆盖，`UPDATE` 绑的是这个计算值，不是客户端原样。 |
| e2e 三级节点给 1012 留幽灵 `stage_done` | **已关闭**。跑完一整轮 e2e 后查 `stage_notice`：`emp_no=1012 AND seen_at IS NULL` = **0 条**（上一轮实证的 `id=369 / task tm4lu1necn` 不再出现）；9.11 收尾同时读掉 SUB 与 1012。 |
| `/api/sync` 丢弃 `stageRef` 未入文档 | **已关闭**。`specs/modules/server-api.md` 明写「`stage_ref` 只由服务端在 `/api/stage/join` 写入：`/api/sync` 收到的 `stageRef` 一律丢弃（落库为 `null`）」，与实测一致（本轮伪造副本 `rv3_f1`/`rv3_f2` 落库 `stageRef=null`）。 |

## 证据重建与残余风险

**复核对象**：树摘要 `a6030feb9974a28f` —— 取自 `_dev/verify-report.json` 的全绿报告（`ok:true`、`full:true`、`at=2026-11-09T05:11:53.979Z`、7 项 checks 全 true）；3 份 PASS 归档契约的「复核对象：树摘要」与之一致（第 4 份 `2026-11-03-阶段责任人.md` 仍 `PLANNED`、复核对象留空，门禁只对 PASS 契约强制锚定）。· base commit `5a52347` · 候选 sha256 `13e68ce1…aed85b7`。写本文件之前实测当前树是 `868a1a14dd96302d`，写完之后又变成 `ac4e979b5d8d0821`（36 个代码文件，多出来的就是本文件）——成因见 RV-5。

- 重跑的命令、退出码与原始证据路径：见下表。行内输出为本轮真实回显；`_dev/verify-report.json` 是唯一留档的报告文件（`.gitignore` 内，不进交付树）；定向探针脚本与日志跑完即删，命令可原样复跑。

### 确定性检查（全部真跑）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node _dev/e2e.mjs http://127.0.0.1:8799` | **0** | `===== 合计 163 项，失败 0 项 =====`；9.11 段 13 条断言全 PASS（上级详情页别人那段无 `data-act="stage-toggle"`、上级绕过界面勾被拒、加入待办拿到反指副本、副本只读且无删除按钮、责任人勾完成→上级 `done=true/doneBy=1003/status=doing`+恰好 1 条 `stage_done`、完成计数 `1 / 2`、承接台「完成」标签、旧快照改标题/改结束日 `d(7)` 落库且完成态不被冲、`status` 非 `done`、不反向下写副本、第三人勾被拒、移除段后副本被收走） |
| `node _dev/verify.mjs --fast` | **0** | 5 项全绿：语法 12 个文件 · 版本 v0.8.5（34 个版本）· CHANGELOG 一致 · 契约状态 4 份 · 门禁反面用例 7 种全拦；`树 868a1a14dd96302d（35 个代码文件 / 31 个文档）` |
| `_dev/verify-report.json` 核对（`--full` 由交付方跑，本轮不重跑） | — | `ok:true`、`full:true`、`digest:a6030feb9974a28f`、`mode:--full`；`checks` 7 项 `ok` 全 true（含 `e2e 163 项`）；`each` 66 项（`codeFiles:35`、`evidenceFiles:26`，其中 `artifacts/` 6 项、含 `verdict.md`） |
| `python .agents/gates/gate.py --ci --repo .` | 按任务约定不跑 | 提交后由机器步骤执行（M2/M6 依赖本份 verdict 事件），不计入 NOT_RUN |

### 上一轮 6 条 finding 在新候选上的自证（`rv3_up` 探针，自建数据跑完即删、提醒标已读）

- **F1 伪造 `stageRef` 点亮别人的段**：1004 建 `rv3_f1`(→`a1`，`who=1003`)、`rv3_f2`(→`b1`，无 `who`)。回读父任务 `p1/a1/b1/c1` 全部 `done=false`、`status=todo`、1012 **0 条**提醒；两条伪造任务 `stageRef` 落库均为 `null`。**仍成立**。
- **正向唯一上行通道**：1003 `join` 后在自己副本勾完成 → 父 `a1` `done=true/doneBy=1003`、任务 `status=doing`、1012 恰好 1 条 `stage_done`。**仍成立**。
- **F3 已完成段换人**：1012 换人给 1005（快照里带 `done=true`）→ 回读 `a1 = 1005:whoAt空:done✗:doneBy空`（完成态清零）、1003 的旧副本已从可见列表消失、第三方 `1003` 再伪造副本无效（父段不变）。换人后 `status` 仍为 `doing`（未被回退）。**仍成立**。
- **F2 新增/夹带完成态**：整段提交新增 `n1{who:1004, done:true, doneBy:1012}` → 回读 `done=false/doneBy=null`；同一提交给别人的 `a1` 夹带 `done=true` → 保持 `false`。**仍成立**。
- **F6 移除段后副本**：1004 `join` 得到 `st_rv3_up_c1`；1012 整段提交移除 `c1` → 1004 侧该副本消失，并收到 `removed` 提醒；父任务无 `c1`。**仍成立**。
- **收尾自清**：探针结束回读父任务 = `null`；库内 `id LIKE 'rv3%' OR id LIKE 'st_rv3%'`、`stage_ref LIKE '%rv%'` 均为 0 条。

### 越界检查

- `git diff HEAD` 共 **11 个已跟踪文件**：`server.js`、`public/app.js`、`_dev/e2e.mjs`、`specs/modules/server-api.md`、`specs/modules/app-ui.md`、`version.js`、`CHANGELOG.md`、`.agents/issues.md`、3 份 `.agents/archive/contracts/*.md`。前 7 个在契约 `in_scope` 内；`.agents/issues.md` 是 AGENTS §6 要求的台账；3 份归档契约按仓库既有口径（复核对象 = 最新绿报告摘要）重锚，delivery 已说明，属已处置项，本文件不再作为 finding 重复计分。
- 未动表结构（无 DDL/`ensureColumn` 变更）、未改 `/api/sync` 请求/响应形状、未改 `/api/stage/*` 的入参出参、未改日期与工作日算法、未触碰生产实例 `172.17.0.85`。
- 测试数据：`rv3_*`/`st_rv3_*`/`rv2_*`/`st_rv2_*` 全为 **0 条**，`stage_ref` 反指残留 0 条，我造的提醒已标已读（`emp 1012` 未读 = 0）。终检残留均非本轮探针数据：`1001 ×1`（`1012_t2`，存量演示 `dispatched`）、`1005 ×2`（`1012_t4`，e2e 拖动演示自产 `moved`）。

### 与 Worker 证据的差异

1. delivery 称「树摘要 `a6030feb9974a28f` 全绿」与绿报告一致，但**当前树已不是那棵**（`868a1a14dd96302d`），差异只在 `artifacts/` 证据文件，代码与 specs 内容未变 —— 这份报告是快照，不是可复现的「当前这棵树」，见 RV-5。
2. delivery 称 9.11「**13 条**断言」——实测一致（`_dev/e2e.mjs` 1827–1958 段共 13 处 `check(`：1860/1864/1870/1880/1894/1903/1913/1927/1930/1932/1934/1938/1949）；上一轮指出的「14 条」已改正。
3. delivery 的 `not_run: none` 与本轮核对一致；`gate.py --ci` 属提交后机器步骤，按约定未跑，不计入 NOT_RUN。
4. 其余可核实项与 delivery 一致：e2e 163/0、候选摘要 `13e68ce1…`、3 份 PASS 契约复核对象均为 `a6030feb9974a28f`、存量补数清单（「副本已完成、阶段未完成」= 0 条）。

### NOT_RUN 清单

none

### 残余风险

- 结构性：`artifacts/`（含本文件）计入 code digest，导致「复核对象」锚点随每次证据写入漂移（RV-5），跨任务存在。
- 长开页面用旧快照整段提交会清空该段 `who` 并收走副本（对方收到 `reassigned`，不静默），属已知边界。
- 「全完成 → 逐个撤销」经 `toggleStage` 停在 `doing`（保留「已开始」）；若某次整段提交一次性把所有叶子从 `done` 撤回，会落到 `todo`。语义可接受，未登记 finding。
- `2026-11-03-阶段责任人.md` 仍 `PLANNED` 且复核对象留空——门禁只对 PASS 契约强制锚定，不构成本任务问题。

### 判定理由

- 实现层干净：Human 四条口径与 `specs/modules/server-api.md` / `app-ui.md` 的新不变量一致，F1–F6 与上一轮 3 条 P3 全部在新候选上亲手复现通过，`status` 无空值路径，换人/移除/父任务删除三条路径都收副本，无双向循环，e2e 163 项 0 失败，`/api/sync` 与表结构未变，无越界与测试数据残留。
- 上一轮的唯一阻塞点（归档契约锚在上一代树上、`verify --full` 退出码 1）已按仓库既有口径处置：3 份 PASS 契约的复核对象 = 最新绿报告 `a6030feb9974a28f`，`verify --fast` 契约状态 4 份判绿、退出码 0。
- 仅剩 RV-5 的结构性锚点漂移（P3，不阻塞实现、不影响本任务验收），故 `max_severity: P3`、`verdict: PASS`。
