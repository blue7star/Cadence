<!-- `task submit --evidence <路径>` 必填；本文件由 Reviewer 人写，工具只校验与封存，不代写。 -->

# Verdict — TASK-20261109-gate-hardening（attempt 2）

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: TASK-20261109-gate-hardening
contract_version: 1
candidate_revision: 2
candidate_digest: 493d87d721508d31d21a0e56992eb832f103439c16f327841227438896043ef8
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
reviewer: Reviewer
reviewer_context: review-subagent-20261109-gate-hardening-a2
worker_context: planner-main-20261109-gate-hardening
attempt: 2
verdict: FAIL_IMPLEMENTATION
max_severity: P1
evidence_status: COMPLETE
not_run_count: 0
supersedes: 1

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明：本上下文是新开的 Reviewer 会话（`review-subagent-20261109-gate-hardening-a2`），未参与实现，未读取实现者的私有过程信息；只读仓库现状、契约、delivery、attempt 1 verdict 与候选补丁。先核对 `candidate-a2.patch` 的 sha256 = `493d87d7…043ef8`（与 delivery 一致）。所有对抗性探针都建在 `%TEMP%\a2probe\` 的独立 git 仓库里，用真实 `gate.py` 以子进程执行，未改动 Cadence 仓库任何文件、未 `git add`/`git commit`、未停 8799 端口服务（探针脚本导入 gate 模块时产生的 `__pycache__` 已清除，未进索引）。
- 本次读取的项目权威：`AGENTS.md` §1-§7；`.agents/review-checklist.md`；`.agents/SPEC.md`；`.agents/gates/gate.py`（全文）；`.agents/gates/protected.json`；`.githooks/pre-commit`；`.github/workflows/ai-native-gate.yml`；`.agents/scripts/agent_workflow.py`（RULE_EPOCH）；`.agents/templates/{task,delivery,verdict}.md`；`.agents/schemas/task.json`；`_dev/verify.mjs`（`contracts()` 与 `treeDigest()`）；`specs/modules/*.md` 的 `paths:`。
- 已核对的 Task Contract 与 delivery 摘要：契约 `gate_level: G2`、`base_revision` 与 HEAD 一致、五个受理字段齐备；delivery 自称 `--selftest` 9/9、`--full` 8 项全绿、`--ci` 0、`--fast --staged` 0、产品零改动。逐条复跑结论见下——`--selftest`/`--fast --staged`/`--ci` 与 delivery 一致，**`--full` 与 delivery 不一致**（本机实测红）。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
| F1 | **P1** | impl_bug（证据与候选不一致） | 契约 `acceptance_command` 要求 `node _dev/verify.mjs --full` 退出码 0，本机实测 **exit 1**：`FAIL 契约状态 4 份`——三份历史 PASS 契约的「复核对象」写 `c007faff515c2418`，而 `_dev/verify-report.json` 的 `digest=f93c512665f816bf`。`node _dev/verify.mjs --hook`（pre-commit 第一条轨）同样 **exit 1**（1/5）。`_dev/verify-report-last-fail.json` 记录的当前树摘要也是 `f93c512665f816bf`，即**树自 06:37Z 那次绿跑之后没变过**，红来自重锚值本身。机制：`contracts()` 用「上一次绿报告」的 digest 做对账，绿跑结束后又把它覆盖成新 digest；本候选把契约重锚到 `c007faff…`（那一次的旧 live），却在新一次 `--full`（06:37Z）里被判绿并写入 `f93c5126…`——重锚值天生落后一代，此后**任何一次 `--full` 都红**，候选无法通过自己安装的 pre-commit（唯一出路是 `--no-verify`）。另：`--full` 因短路只跑了 6 项，`门禁反面用例`/`契约门禁反面用例` 两项根本没执行，delivery 引用的 8 项输出不可复现 | 重锚到**交付态这棵树**的摘要（当前 `f93c512665f816bf`），然后**连续跑两次 `--full`**，两次都必须 0；把「重锚后必须复跑并贴第二次输出」写进 delivery 模板。根因是自指对账，建议同时把 `artifacts/` 排除出代码摘要（issues #64），否则写完 verdict 又会失效 |
| F2 | P2 | machine_gate_miss | 探针（真实模板版式、`modules: server-api`、改 `server.js`）：`out_of_scope: 待定，回头再补` → **M8 PASS**；`acceptance_command: 看情况` → **M8 PASS**；`acceptance_command: N/A` → **M8 PASS**。attempt 1 的 F4 正是点名了这几个字符串，要求「包含式判定 + acceptance_command 追加形状约束」，本版只补了 `TBD 稍后补`/`暂无`/`未定`，`待定`/`回头再补`/`看情况`/`N/A` 仍能过关。M8 仍可被一个敷衍词绕过 | `PLACEHOLDER_VALUE` 补 `待定|回头再补|看情况|待议|n/?a`；`acceptance_command` 增加形状约束（必须含可执行命令 + 「退出码」/期望值）；selftest 把这三条固定成反例 |
| F3 | P2 | machine_gate_miss | `blueprint_paths()` 在索引/HEAD 取不到蓝图时**回退读工作区文件**（gate.py L393-397）。探针：`specs/modules/ghost.md` 未跟踪（`paths: *`），契约 `modules: app-ui, ghost`，只暂存 `server.js` → **M1 PASS**（"admitted, 1 protected staged paths"）；CI 模式同一条回退路径，提交里根本没有 `ghost.md`（`git ls-tree HEAD` 无此项）却 **M1 PASS**。这与 delivery 的「P2-2 修复：未暂存的蓝图扩权不算数 / `--ci` 读 HEAD」直接相反；且 `paths: *` 可一次覆盖全部受保护面（连自己 `specs/modules/ghost.md` 也覆盖） | staged/CI 模式去掉工作区回退：蓝图不在索引/HEAD 即视为「无归属」（`[]`），只有显式白名单才允许 worktree 读取；`paths:` 拒绝 `*`/`**`/裸 `/`，要求是具体文件或目录前缀 |
| F4 | P3 | machine_gate_miss | `is_protected()` 仍区分大小写与分隔符：同一份 `protected.json` 下 `Server.js`/`Public/app.js`/`PUBLIC/app.js`/`./server.js`/`public\app.js` 全为 `False`。attempt 1 的 F5 要求的「判定前 casefold + 规范化」只落到了 `path_covered`（模块归属），没落到受保护面判定。实用性有限：本机 `git add Server.js` 被 `core.ignorecase` 归并成 `server.js`，探针结果为「no staged changes」，故只算 P3 | 在 Windows 语义下对 `is_protected` 统一 `casefold()` 并规范化 `./`、`\`；CI 保留严格判定，并补一条 selftest |

## 证据重建与残余风险

- 重跑的命令、退出码与原始要点：
  1. `python .agents/gates/gate.py --selftest` → **exit 0**，9/9。逐条看过：`partial_cover`（只声明 `app-ui` 改 `server.js`）确实断言 M1 `BLOCKED` 且退出非 0；`sectioned` 用例把 `## 受理` 插在第一个受理字段之前，确实走跨小节解析；`weak_placeholder` 只覆盖 `TBD 稍后补`。用例本身没有「打印通过但其实没断言」的问题，但覆盖面比 delivery 的描述窄（未固定 `待定`/`看情况`/未跟踪蓝图）。
  2. `python .agents/gates/gate.py --fast --staged --repo .` → **exit 0**；`M1 PASS "TASK-20261109-gate-hardening (G2) admitted, 15 protected staged paths"`、`M8 PASS "受理五字段齐备"`、`M3 PASS "5 blueprints updated"`。attempt 1 的 F1（真实契约恒 BLOCKED）**确实已修复**。
  3. `python .agents/gates/gate.py --ci --repo .` → **exit 0**，但 M1/M8/M3 都是 `"no protected path changed"`（`HEAD~1...HEAD` 是上一份 docs 提交），这次绿**证明不了** M1/M8 在新提交上会拦也会放——与 attempt 1 同样的语义空洞。
  4. `python .agents/gates/gate.py --fast --staged` 的等价物 + `node _dev/verify.mjs --hook`：后者 **exit 1**（1/5），见 F1。因 verify 轨先红，`.githooks/pre-commit` 在本机必然非零退出——「缺 python/node 失败退出、双轨」的接线本身成立，但本候选过不去。
  5. `$env:CADENCE_BASE='http://127.0.0.1:8799'; node _dev/verify.mjs --full` → **exit 1**，1/6：`语法检查 12` / `版本 v0.8.5，34 个版本` / `CHANGELOG 一致` 通过，`契约状态 4 份` **FAIL**，`服务在跑 v0.8.5` 通过，`e2e 163 项` 通过，写 `_dev/verify-report-last-fail.json`（digest `f93c512665f816bf`）。服务未被杀。
  6. `git diff HEAD -- server.js public/` → **空**（长度 0）；`docs/adr` 不存在；`gate.py` 无 M7/M9 实现，仅 selftest 文案提到「不接 M9」；`AGENTS.md` §7 明确写 M9 暂缓（给理由）、M7 不引入（只认 pytest，本项目用 e2e，接了是假覆盖）、ADR 只写落点 `docs/adr/NNNN-主题.md` 不建目录。用户第 4 条要求全部满足。
  7. 临时仓库探针（`%TEMP%\a2probe`，真实 `gate.py --fast --staged`；每个用例独立重置到基线提交）：① `modules: app-ui` + 暂存 `server.js` → **M1 BLOCKED**（P2-1 已修）；② `modules: app-ui` + `public/app.js` → **exit 0，M1/M8 PASS**；③ 五字段写在第二个 `##` 小节 → **M8 PASS**（P1 已修）；④ 占位符：`TBD 稍后补`/`暂无`/`<待填>`/空 → 全部 **M8 BLOCKED**（P2-3 的四个指定变体已修），`待定，回头再补`/`看情况`/`N/A` → **PASS**（F2）；⑤ 蓝图只在工作区改成 `paths: public/, server.js`、只暂存 `server.js` → **M1 BLOCKED**（已暂存蓝图口径已修）；⑥ 未跟踪 `ghost.md` `paths: *` → **M1 PASS**（F3）；⑦ 同一文件暂存 `paths: *` 蓝图 → **M1 PASS**（F3 的普通形态）；⑧ `Server.js` → `git add` 后无暂存变化，`is_protected` 直测为 `False`（F4）。另 CI 模式探针：蓝图未提交、提交里无 `ghost.md`，`--ci --base HEAD~1` → **M1 PASS**（F3 在 CI 轨同样成立）。
- 与 Worker 证据的差异：`--selftest`（9/9）、`--fast --staged`（0）、`--ci`（0）一致；`--full` **不一致**——delivery 贴的 8 项全绿是 06:37Z 那次（校验的是上一代 live `c007faff…`），本机交付态第一次复跑就红，且短路掉两项 selftest。delivery 未说明「重锚值与新报告摘要相差一代」，反而把这次绿当作可复现证据。
- NOT_RUN 清单：none。补充说明：`.githooks/pre-commit` 这个 sh 包装没有整段执行（Windows 下等价性足够），而是分别跑了它调用的两条轨（`verify --hook` exit 1、`gate --fast --staged` exit 0），因此 hook 的实际结论是非零退出。e2e 由 `--full` 覆盖（163 项全绿），未单独复跑。
- 残余风险：
  - 候选补丁与交付态不是同一份东西：`candidate-a2.patch`（mtime 14:18）不含 14:32-14:34 才改的归档契约重锚，也不含 `delivery.md`；而 F1 的红恰恰由重锚引起。`candidate_digest` 只标识 diff，无法把「--full 绿证据」钉在候选上——这是流程层的证据绑定缺口。
  - `events.jsonl` 哈希链无密钥，`artifacts/runs/*` 不在受保护面内，整条链可重算伪造（既有设计限制，非本次引入）。
  - `paths: *` 是自声明归属的万能钥匙；M1 现在要求「每个受保护路径都有归属」，一把万能钥匙即可满足（F3 的第 7 条探针）。
  - 交付态的暂存区里 `artifacts/runs/.../verdict.md` 处于 `AD`（索引有、工作区已删），提交时会把 attempt 1 的 verdict.md 复活成正式结论文件；若随后写入 PASS 事件，M2 可能读到这份 FAIL verdict。提交前应清掉该索引项。
  - `.agents/README.md` 仍写 `--selftest` 覆盖「六种情况」，与实现的 9 个用例不符（文档漂移，P3 级，未单列 finding）。
  - `--no-verify` 仍无服务端强制；钩子依赖每台机器 `git config core.hooksPath .githooks`，这条「不做就静默失效」的说明仍在 AGENTS.md §5。
- 判定理由：attempt 1 的两个核心问题（M8 对真实契约恒 BLOCKED、M1「命中一个即放行」）都已用真实 `gate.py` 复现为修复状态，受保护面接回真实代码、pre-commit 双轨与 fail closed、M9/M7/ADR 的取舍也都成立。但交付态**过不了自己的验收命令**：`--full` 与 `--hook` 都 exit 1，原因是本候选自己写下的归档契约重锚值落后一代，而 delivery 把那一刻的绿当成了可复现证据（F1，P1）；同时 P2-2 声称的「未暂存/未提交蓝图不扩权」被工作区回退与 `paths: *` 击穿（F3），M8 仍可被 `待定`/`看情况` 绕过（F2）。故判 `FAIL_IMPLEMENTATION / P1`。返工时不必推翻整体设计，只需修 F1 的重锚与复跑流程、F2 的占位符形状、F3 的回退与通配（F4 可一并改）。
