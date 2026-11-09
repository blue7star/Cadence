# Verdict — TASK-20261109-subtask-upstream

## 身份（机器读）

task_id: TASK-20261109-subtask-upstream
contract_version: 1
candidate_revision: 1
candidate_digest: a4d340d3da8d5edf6dab9a3f319d36856810a0afe758f8b68c44e528d639f758
base_revision: 5a523476827f8fadf58f8245079443df1b9636b1
reviewer: Reviewer
reviewer_context: reviewer-subagent-20261109-b
worker_context: 6af130d07cf2c26848cc987d
attempt: 2
verdict: FAIL_IMPLEMENTATION
max_severity: P2
evidence_status: COMPLETE
not_run_count: 0
supersedes: 1

## 独立性

- **独立声明**：本轮为新上下文、未参与实现，只依据工作区代码、本地库、`/api/*` 实测、e2e 与 verify 的输出取证。`delivery.md` 只作为线索，其结论已逐条自证，并**证伪了其中两条**（见「与 Worker 证据的差异」）。
- **权威**：`AGENTS.md` §2/§4/§6、`.agents/templates/verdict.md`、`.agents/archive/contracts/_template.md`、`specs/modules/server-api.md`、`specs/modules/app-ui.md`、本任务 `task.md`。
- **已核对**：契约 `in_scope`/`forbidden`、Human 四条业务口径（子任务完成只由该段责任人勾、上行只走副本→父、上级计划类权限保留、不得双向循环）、上一轮 6 条 finding（F1–F6）、表结构/`/api/sync` 形状/日历算法是否被改。
- 候选摘要独立复算：对 `git diff HEAD` 原始字节做 sha256 = `a4d340d3…d639f758`，与 delivery 声明一致，工作区未漂移。

## Findings

| ID | 级别 | class | 证据（我亲手复现的字段/输出） | 要求路线 |
| --- | --- | --- | --- | --- |
| RV-1 | P2 | contract_gap | `node _dev/verify.mjs --full` **退出码 1**：`[失败] 契约状态 4 份（交付即须复核，复核绑树摘要）` → `2026-11-03-三级节点.md` / `2026-11-03-下派自由选择与知情人.md` / `2026-11-04-子任务责任人与发布任务.md`「状态 PASS 但 复核对象不是当前这棵树（报告是 2dcf30155a871ec4）」；三处写的是 `树摘要 3e233fabeb65c9df`。我把 `_dev/verify-report.json` 的 65 个文件 hash 与当前树逐一比对，**0 处漂移**，即当前交付树就是 `2dcf30155a871ec4`；`delivery.md` mtime(12:41:54) 晚于产出 `3e233` 的那次 `--full`（按 mtime 与摘要漂移推定：`3e233` 是写完交付说明之前的树，从未是当前树）。归档模板 `_template.md:37` 明文要求「必须与这次 `_dev/verify-report.json` 里记的一致，否则复的不是这版代码」。同时该三处写「e2e 160 项」，实测 163 项。 | 所有 artifacts（含本 verdict）定稿后**重跑一次 `--full`**，把三处「复核对象 树摘要」改成当次 report 的摘要（`.agents/` 属 DOC_ONLY，改它不会再抖摘要），并把「160 项」改成实际条数。**结构性根因**：`artifacts/` 被算进 code digest（`_dev/verify.mjs` 的 DOC_ONLY 不含 `artifacts/`），而事件/交付/复核文件都写在这里，锚点必然随证据写入漂移；建议把 `artifacts/` 纳入 DOC_ONLY 或 .gitignore，否则每个 PASS 都只能绿一次、连跑两次必红（需另行登记，超出本任务 in_scope）。 |
| RV-2 | P3 | contract_gap | 新建专项（1 个阶段 + 1 个该段叶子、0 完成）提交 `status=doing` → 落库回读 `status=todo`（我已按 F4 同条件复现）。示例数据 `1012_t4` 现为 `todo`，但库里 `s1/s2` 的 `done=true`，界面会呈现「两个阶段已勾、整体待办」。`paused` 已按文档保留（新建即 `paused`、再次提交 `paused` 均回读 `paused`）。 | 要么允许手选 `doing` 落库（仅在「全完成」与「从 done 退回」时介入），要么在详情页对「有子任务且 0 完成」的任务禁用/隐藏「进行中」并提示「由子任务推进自动切换」——不能让下拉选项静默失效（与 #61「点了保存什么都没变」同类）。 |
| RV-3 | P3 | testcase_gap | 9.11 的提醒隔离**已修好**（每轮开头 `/api/notice/seen {me:1012}`，`doneNotice===1` 为精确值，我复跑确认恰好 1 条）。但 e2e 新改的「拖有子任务的阶段」段以 1002 身份 `/api/stage/toggle`，只把 **1002** 的提醒标已读；属主 **1012** 收到的那条 `stage_done` 未标已读、且随后父任务被删。库内实证（每跑一轮复现一条）：`stage_notice` id=369，`kind=stage_done`，`emp_no=1012`，`task_id=tm4lu1necn`（任务已被该段删除），`summary=李明完成了「子任务A」`，`seen_at=null`；上一轮同样留下 id=341/`taciteu20i`。 | 该段收尾时补 `await act('/api/notice/seen', { me: '1012' })`（或按 taskId 精确标读），别把「完成」提醒留成下一轮的幽灵待办。 |
| RV-4 | P3 | contract_gap | `specs/modules/server-api.md` 不变量仍写「生成 temp 必须带 `stage_ref` 反指且幂等」，而代码在 INSERT 时**强制把客户端提交的 `stageRef` 写 null**（安全修复本身正确；我实测 `rv2_forge1/2/3/4` 落库后 `stageRef=null`，伪造副本点不亮任何段）。文档没登记这条口径，读者会以为 `/api/sync` 传 `stageRef` 有效。 | 在不变量里补一句：副本只能由 `/api/stage/join` 生成，`/api/sync` 不接受客户端 `stageRef`。 |

## 证据重建与残余风险

**复核对象**：树摘要 `2dcf30155a871ec4`（`node _dev/verify.mjs --fast` / `_dev/verify-report.json` 实测，65 个文件；写入本文件后 `artifacts/` 变化会使摘要再变，原因见 RV-1）· base commit `5a52347` · 候选 sha256 `a4d340d3…d639f758`。

- 重跑的命令、退出码与原始证据路径：见下表（日志均落在 .gitignore 内的 `_dev/*.log`，复核结束已清理；按同命令可复跑）。

### 确定性检查（全部真跑）

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `node _dev/e2e.mjs http://127.0.0.1:8799` | **0** | `合计 163 项，失败 0 项`；9.11 的 13 条断言全 PASS（含「承接台『有变动的任务』：下属完成后上级看到『完成』标签」「上级详情页的完成计数跟着变（1 / 2）」「上级改计划字段（结束日）…」「父任务移除这一段：责任人那条副本被服务端收走」；日志在 .gitignore 内、复核结束已清理，按同命令可复跑） |
| `$env:CADENCE_BASE='http://127.0.0.1:8799'; node _dev/verify.mjs --full` | **1** | 6 项通过（语法 / 版本 / CHANGELOG / 门禁反面用例 / 服务版本 / e2e 163），**契约状态 1 项失败**（RV-1）。同一命令在本会话首次跑（12:51）曾显示 7 项全绿——那次比的是**上一次** green report 里的 `3e233`（`contracts()` 读的是旧报告），而那次 `--full` 写下的报告已是当前树 `2dcf`；因此「全绿」不可复现，第二次必红 |
| `python .agents/gates/gate.py --ci --repo .` | 按任务约定不跑 | 由提交后机器步骤执行（M2/M6 依赖本份 verdict 事件），不计入 NOT_RUN |

`not_run_count: 0`。NOT_RUN 清单：none（`delivery.not_run: none`，无跳过项）。

### 上一轮 6 条 finding 逐条自证（自建 `rv2_*` 数据，跑完即删、提醒标已读）

- **F1 伪造 `stageRef` 点亮别人的段**：1004 建 `rv2_forge1`(→a1, who=1003) / `rv2_forge2`(→b1, 无 who)，1005 建 `rv2_forge3`(→u1，who=1005 但**未派发**)。结果：父任务 a1/b1/u1 全部 `done=false` 原样，父任务 `status=todo`，1012 **0 条**提醒；两条伪造任务的 `stageRef` 落库为 `null`。**已修好**（`pullStageFromMirror` 的 `who===owner_no` + `whoAt` 双校验生效；客户端 `stageRef` 不再落库）。
- **F2 新增 `who=别人 done=true` 的叶子**：整段提交新增 `n1{who:1004, done:true, doneBy:1012}` → 回读 `{done:false, doneBy:null}`；同一提交把别人的旧叶子 `a1` 夹带 `done=true` → 回读 `done=false`。**已修好**（`keepForeignDone` + 新任务清零）。顺带验证旧快照 `done=false` 提交后已完成的段仍 `done=true`。
- **F3 已完成段换人**：1003 经副本勾完成 → 父 a1 `done=true/doneBy=1003`、任务 `status=doing`、1012 恰好 1 条 `stage_done`；随后 1012 换人给 1005（快照里仍带 `done=true`）→ 回读 a1 `{done:false, doneBy:null, whoAt:false}`；1003 的旧副本已从可见列表消失，`/api/stage/toggle` 被拒「这一段由别人负责，只有他能勾完成」，再伪造副本也无效果。**已修好**。
- **F4 `paused` 被打回**：新建专项提交 `status=paused` → 回读 `paused`；再提交 `paused` → 仍 `paused`；单叶子完成后（全完成）→ `done`，取消勾选 → `todo`（paused 已随 done 被覆盖，属预期边界）。**paused 已修好**；残留 `doing` 静默回退见 RV-2。
- **F5 9.11 断言与残留**：`doneNotice===1` 为精确值、前置清空生效；承接台「完成」标签有 UI 断言；改期断言了 `end` 落库值（我的实测 c1 `end=2026-11-21`，且 1004 收到 `moved`、完成态未被翻动）。**已修好**；同类残留出现在 e2e 另一段，见 RV-3。
- **F6 移除段后副本**：1004 `join` c1 得到 `st_rv2_ups_c1`；1012 整段提交移除 c1 后，1004 侧该副本消失、收到 `removed` 提醒，父任务无 c1。**已修好**（换人/移除/父任务删除三条路径都收副本；`who` 被清空也会收）。

### 越界检查

- `git diff HEAD --stat` 共 11 个文件：`server.js`、`public/app.js`、`_dev/e2e.mjs`、`specs/modules/server-api.md`、`specs/modules/app-ui.md`、`version.js`、`CHANGELOG.md`、`issues.md`、`.agents/issues.md`、`.agents/archive/contracts/`×3。前 8 个在契约 `in_scope`（含「文档同步」）内；`.agents/issues.md` #63 是 AGENTS §6 要求的台账；`.agents/archive/contracts/` 3 处属**越界**（归档目录按 §4 是「只读留档」，gate 的 IGNORE_DIRS 也不检查它），且改写的是历史复核记录并留下了对不上号的摘要（并入 RV-1）。建议不要再改归档正文，改为在任务目录里记录「本条被新契约取代」。
- 未动表结构（无 `ensureColumn`/DDL 变更）、未改 `/api/sync` 请求/响应形状（只是忽略 `stageRef` 字段，见 RV-4）、未改日期/工作日算法、未触碰 `172.17.0.85`。
- 测试数据：自建 `rv2_*` / `st_rv2_*` 已全部删除（终检：`id LIKE 'rv2%' OR stage_ref LIKE '%rv2%'` = **0 条**），我造的提醒已标已读；`_dev/*.log`、`_dev/*.json`、`data/workbench.db` 均在 .gitignore 内，工作区只剩候选改动 + `?? artifacts/`。终检时库内仍有未读提醒：`emp 1001 ×1`（2026-11-04 存量演示）、`emp 1012 ×1`（id=369，即 RV-3 那条幽灵 `stage_done`）、`emp 1005 ×4`（id=349/350/360/361，e2e 拖动/改名演示数据留下的 `moved`）——后两类是 e2e 自产，不是我的探针数据（保留现场供复现 RV-3）。

### 与 Worker 证据的差异

1. delivery 称「`verify --full` 七项全绿」——**现不可复现**（1 项红、退出码 1，见 RV-1）。
2. delivery 称 9.11「14 条断言」——实测 **13 条**（`check(` 计数 + 日志 PASS 行）。
3. delivery 称归档契约「复核树摘要对齐当前绿报告」——实际对齐的是**上一版**树摘要 `3e233`，且条数写成 160（实际 163）。
4. 其余可核实项与 delivery 一致：e2e 163/0、候选摘要 `a4d340d3…`、存量补数清单（库内「副本已完成、阶段未完成」= 0 条）、未落库生产。

### 残余风险

- 结构性：`artifacts/` 计入 code digest，导致「复核对象」锚点在交付/复核写入后必然漂移（RV-1 的根因，跨任务存在）。
- 长开的承接人页面用旧快照整段提交，会清空 `who` 并收走副本（对方会收到 `reassigned` 提醒，不静默），属已知边界，未列入本轮 finding。
- `paused` 只有在「未全完成」期间被保留；一旦全完成再取消勾选会回到 `todo`，没有单独的暂停标记，口径可在文档里补一句。

- **判定理由**：实现层是干净的——上一轮 6 条 finding 全部被我亲手复现并确认修好，Human 四条口径（责任人独占完成、上行唯一通道、上级计划权限、无双向循环）与两份 specs 的不变量一致，e2e 163 项 0 失败，`/api/sync` 与表结构未变，无测试数据残留。

  但按本仓库的硬口径复核**不能签 PASS**：`_template.md:37` 要求复核对象「必须与这次 `_dev/verify-report.json` 里记的一致」，而交付树实测为 `2dcf30155a871ec4`，三份归档契约写的却是 `3e233fabeb65c9df`，`node _dev/verify.mjs --full` 在交付树上**退出码 1**——即「证据锚在一棵不是本版的树上」，这正是模板要防的情形，且可由交付方在本轮用「定稿后重跑 `--full` 再重锚 3 行」低成本修好。故按 P2（对账口径不一致）判 `FAIL_IMPLEMENTATION`；实现本身无需返工，只需重锚证据（并把 `artifacts/` 是否计入摘要的问题单独登记）。
