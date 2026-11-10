# Verdict — TASK-20261109-gate-hardening

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: TASK-20261109-gate-hardening
contract_version: 1
candidate_revision: 1
candidate_digest: fd13e3c61ca3db440ef7ff4dab7fcd2d4e9ca3bfc13c6b74475c1338c5c9fbd3
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
reviewer: Reviewer
reviewer_context: review-subagent-20261109-gate-hardening
worker_context: planner-main-20261109-gate-hardening
attempt: 1
verdict: FAIL_IMPLEMENTATION
max_severity: P1
evidence_status: PARTIAL
not_run_count: 1
supersedes: none

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明：本上下文是独立 Reviewer 会话，未参与本次实现，未使用实现者的私有过程信息；只读 `task.md`、`delivery.md`、`candidate-a1.patch`、`evidence/baseline-probe.txt` 与仓库现状。所有反例都在**仓库外**的临时目录里用真实 `gate.py` 复现（脚本用完即删），未改动仓库任何文件、未提交、未执行 `git add`。按任务要求**未运行** `node _dev/verify.mjs --full`。
- 本次读取的项目权威：`AGENTS.md` §1-§7；`.agents/README.md`；`.agents/templates/{task,delivery,verdict}.md`；`.agents/schemas/task.json`；`.agents/gates/{gate.py,protected.json}`；`.githooks/pre-commit`；`.github/workflows/ai-native-gate.yml`；`_dev/verify.mjs`（§3 契约状态 / §4 树摘要 / §5 入口）；`specs/modules/*.md`。
- 已核对的 Task Contract 与 delivery 摘要：契约 5 个受理字段齐备、`gate_level: G2`、`base_revision` 与仓库 HEAD 一致；delivery 声称 `--selftest` 6/6、`--full` 8 项全绿、`--ci` 0、测试证据见 §验证证据。逐条复跑结论见下。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
| F1 | **P1** | impl_bug | `python .agents/gates/gate.py --fast --staged --repo .` → **exit 1**，M8 `BLOCKED`：“requirement_quote 缺失；user_problem 缺失；out_of_scope 缺失；acceptance_command 缺失；stop_conditions 缺失”，而本 run 的 `task.md` 五项全都写了。直测 `gate.parse_record(artifacts/runs/TASK-20261109-gate-hardening/task.md)` 只得到 10 个元信息字段（`intake_missing` = 全部 5 个）。根因：`parse_text` 在元信息块后的第一个空行 `break`，而模板把受理五字段放在空行之后的 `## 受理` 小节。临时仓库对照：按模板版式填写 → M8 `BLOCKED`；压成单块 → M8 `PASS`。即**所有 rule_epoch≥4 的受保护提交恒被拦**，唯一出路是 `--no-verify`（AGENTS.md §4 称其为“把闸拆了”）。`--selftest` 之所以 6/6 绿，是因为 fixture 用扁平版式，从未覆盖仓库真实模板 | 修实现：M8 读全文键值（或在 `## 受理` 处继续解析），不要复用“只读头部块”的 `parse_text`；`--selftest` 增一条**直接以 `.agents/templates/task.md` 为版式**的用例，防止 fixture 与模板再次脱节 |
| F2 | P2 | machine_gate_miss | 临时仓库：蓝图 `app-ui.md` 写 `paths: public/`，契约 `modules: app-ui`，同时暂存 `server.js` + `public/app.js` → M1 `PASS`（"TASK-PROBE (G2) admitted, 2 protected staged paths"）、M8 `PASS`、exit 0。覆盖判定是“存在一个被 covered 的路径”，不是“每个受保护改动都被 declared module 覆盖”。于是任何带一个 `_dev/`、`.agents/` 或 `public/` 文件的契约，都能顺带改 `server.js`（接口/数据层）而不被拦——正是本任务要堵的那条缝 | 改规则：`touched` 中每个受保护路径都必须被某个声明模块覆盖，否则 BLOCKED；或强制 `--task` 且 modules 必须覆盖全部 touched |
| F3 | P2 | machine_gate_miss | 临时仓库：蓝图已提交为 `paths: public/`，仅在工作区（**未暂存**）改成 `paths: public/, server.js`，然后只暂存 `server.js` → M1 `PASS`；且 `git diff --cached --name-only` 里没有 `app-ui.md`。归属是从工作区文件读的，与 `--staged`“未暂存改动是草稿、不参与判定”的口径直接冲突；CI 分支（非 staged）则完全不调用 `module_intersects`，提交进历史后的归属声明无人校验 | 归属只读索引区/HEAD blob（`git show :specs/modules/<m>.md`）；CI 路径也校验 modules 与改动路径的交集 |
| F4 | P2 | machine_gate_miss | 临时仓库：`requirement_quote: TBD 稍后补`、`user_problem: 暂无`、`out_of_scope: 待定，回头再补`、`acceptance_command: 看情况`、`stop_conditions: N/A` → M8 `PASS`（exit 0）。`PLACEHOLDER_VALUE` 只匹配“整值恰好等于 `<…>`/`TBD`/`-`/`none`”，带后缀或同义敷衍词全部放行，受理闸退化成“有五个 key 就算答完” | 判定改为包含式/前缀式，并对 `acceptance_command` 追加形状约束（含可执行命令 + 期望退出码）；`--selftest` 补“TBD 稍后补”“暂无”这类反例 |
| F5 | P3 | machine_gate_miss | 探针直调 `is_protected`（同一份 `protected.json`）：`public/app.js`→True，但 `Public/app.js`→False、`PUBLIC/APP.JS`→False、`Server.js`→False、`./server.js`→False、`public\app.js`→False。本项目跑在 Windows（大小写不敏感），大小写变体命中的是同一个产品文件，却绕过了受保护面 | 判定前统一 `casefold()` 并规范化分隔符/前缀（仅在 Windows 语义下），CI 保留严格判定 |
| F6 | P3 | machine_gate_miss | `protected.json` 未列 `启动工作台.bat` / `停止工作台.bat`（产品唯一启动入口，改它等于改运行行为）、`.agents/SPEC.md`（M4 的 `version_authority` 写在里面，改成 `none` 可让 M4 无条件 PASS）、`.pre-commit-config.yaml`（另一份钩子配置）；另 `data/` 列了但仓库里没有任何被跟踪文件，属空设。交付说明自称“按会改运行行为或治理规则枚举”，与事实不符 | 按该口径补全，或在 `protected.json` 注释与 `.agents/README.md` 逐条写明为何排除（像 `docs/`、`CHANGELOG` 那样有理由） |

## 证据重建与残余风险

- 重跑的命令、退出码与原始证据路径：
  1. `python .agents/gates/gate.py --selftest` → **exit 0**，6/6 通过（与 delivery 一致）。
  2. `python .agents/gates/gate.py --fast --staged --repo .` → **exit 1**。M1 `PASS`（"admitted, 15 protected staged paths"）、M3 `PASS`（5 blueprints updated）、**M8 `BLOCKED`**（五项全判缺失）——见 F1。
  3. `python .agents/gates/gate.py --ci --repo .` → exit 0，但 M1/M8/M3 的 detail 都是 “no protected path changed”（`HEAD~1...HEAD` 是上一个 docs 提交）——这次绿**证明不了** M8 在新路径上会拦也会放，只能证明旧提交没碰受保护面。
  4. `node _dev/verify.mjs --fast` → **exit 1**：`FAIL 契约状态 4 份`（归档契约写 `复核对象：树摘要 439e5de39605b8cd`，而本地 `_dev/verify-report.json` 的 `digest=a3066db43cdd6643`）。该失败与本次 diff 无关（两份输入都不在 diff 里），但说明 delivery 的 “8 项全绿” 属于 `06:01:56` 那次运行（报告 `head=f7469a0`、`digest=a3066db…`），而当前树的 fast 报告是 `517bd2df6979b52f`——`candidate-a1.patch`/`delivery.md` 落盘后 `artifacts/` 计入代码摘要，**交付态的绿证据不可复现**。
  5. 用 git 自带 `sh` 执行 `.githooks/pre-commit` → **HOOK_EXIT=1**（verify 轨先红，`|| exit 1` 生效，`gate.py` 轨未被执行）。结论：pre-commit 失败确实非零退出（交付要点成立）；但当前两条轨都过不去，本候选无法经双轨提交。
  6. 仓库外临时 git 仓库探针 A–E（真实 `gate.py`，`--fast --staged`）：A 存在覆盖即放行 → M1/M8 PASS；B 未暂存蓝图归属 → M1 PASS；C 宽松占位符 → M8 PASS；D 模板真实版式 → M8 BLOCKED；E 大小写/分隔符变体 → False。对应 F2–F5。
- 与 Worker 证据的差异：`--selftest` 6/6 一致；`--ci` 0 一致但语义为空；`--full` 未跑（任务要求）；`--fast` 与 pre-commit 在本机为红，delivery 未记录这两项。delivery 对 M8 的描述“缺一项或写 `<…>`/`TBD`/`-` 等占位符 → BLOCKED”高估了实现（整值匹配，见 F4），对 selftest 的描述未说明 fixture 与模板版式不一致（见 F1）。
- NOT_RUN 清单：1 项 —— `node _dev/verify.mjs --full`（任务明确要求不跑，太慢；其 `syntax/version/contracts` 三项已由 `--fast` 覆盖且 `contracts` 为红，e2e 与“服务在跑”未验）。
- 残余风险：
  - 事件流哈希链无密钥，`artifacts/runs/*/events.jsonl` 不在受保护面内，任何人可重算整条链伪造 PLANNED/PASS（既有设计限制，非本次引入）。
  - 蓝图 `paths:` 是自声明：同一份契约内可以“改归属 + 改代码”一起过（`specs/` 自身受保护，但由 tooling 拥有 `specs/modules/`），`paths: *` 这类写法可一次性扩权。
  - `--no-verify` 无服务端强制；钩子依赖每台机器执行 `git config core.hooksPath .githooks`，这条“不做就静默失效”的说明仍在 AGENTS.md §5。
  - `verify.mjs` 的“复核对象 == 上一次绿报告摘要”机制会在一次成功 `--full` 后自我失效（写回的新 digest 立刻与归档契约对不上），表现为任何代码改动后 `--fast/--full` 长期为红——既有问题，但会持续逼人改归档契约或绕过。
- 判定理由：本次交付的核心目标（M8 受理闸）在仓库真实契约版式下**恒为 BLOCKED**，而 `--selftest` 的 6/6 绿是 fixture 与模板脱节造成的假绿——这是“自证”的典型形态：用例与实现共享了同一套扁平假设，从未用仓库自己的模板跑一次。再加上 M1 覆盖判定是“存在即放行”、归属读未暂存草稿、占位符判定可敷衍三条可绕过路径，判定 FAIL_IMPLEMENTATION。受保护面接回真实代码、`paths:` 归属替代文件名 stem、pre-commit 双轨与非零退出这几项是有效的，返工时不必推翻。

## 业务语义（仅 G3）

- 不适用：本任务为 G2，diff 未触及 `server.js` / `public/`（`git diff --cached --name-only` 20 项中无这两处），产品行为零变化。
