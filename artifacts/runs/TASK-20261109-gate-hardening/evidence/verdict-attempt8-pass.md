<!-- `task submit --evidence <路径>` 必填；本文件由 Reviewer 人写，工具只校验与封存，不代写。 -->

# Verdict — TASK-20261109-gate-hardening（attempt 8）

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: TASK-20261109-gate-hardening
contract_version: 1
candidate_revision: 8
candidate_digest: 9949da1c2fc0f5a4bb9f3b2b37fe4dfa24b17df981964bdace55b0c0d680920c
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
reviewer: Reviewer
reviewer_context: review-subagent-20261109-gate-hardening-a8
worker_context: planner-main-20261109-gate-hardening
attempt: 8
verdict: PASS
max_severity: P3
evidence_status: COMPLETE
not_run_count: 0
supersedes: 7

## 结论

通过。

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明：复核方式为**新开一轮对话的独立子代理**（`review-subagent-20261109-gate-hardening-a8`），未参与实现、未读实现过程的私有推理，只读仓库现状、`task.md`、attempt 8 `delivery.md`、attempt 7 verdict（`evidence/verdict-attempt7-fail.md`）与候选补丁。**复核对象：树摘要 `f224ef334ec7aa31`**（本机 `--full` 实测），候选补丁 sha256 = `9949da1c…680920c`，与 delivery 声明一致。对抗探针建在仓库外 `%TEMP%\a8probe\repo`（独立 git 仓库，未污染 Cadence），用真实 `gate.py --fast --staged` 子进程执行；Cadence 仓库本轮只新增本文件，未改代码/契约、未 `git add`/`commit`、未删文件。
- 本次读取的项目权威：`AGENTS.md` §2-§7、`.agents/templates/{task,delivery,verdict}.md`、`.agents/README.md`、`artifacts/runs/TASK-20261109-gate-hardening/{task.md,delivery.md}`、`.agents/gates/gate.py`（`PLACEHOLDER_*` L583-636、`intake_problems`、`check_m8`、selftest 用例表）、`.github/workflows/ai-native-gate.yml`。
- 已核对的 Task Contract 与 delivery 摘要：`gate_level: G2`、受理五字段齐备、`base_revision` 与 HEAD 一致；本版声称「`_placeholder_after_filler` 比对前剥两端非文字字符（`PLACEHOLDER_EDGE`），空段视为不承载内容」「selftest 26 条」「`--full` 8 项全绿、树 `f224ef334ec7aa31`、e2e 163」。逐条复跑结论见下。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
| — | NONE | — | attempt 7 的 F1（占位符等价类没归一到标点）**已关闭**：`PLACEHOLDER_EDGE` 在每次比对前剥掉两端 `[^0-9A-Za-z\u4e00-\u9fa5]`，`以后再补…`、`以后再补吧～`、`待办（回头再补）…`、`待定…，回头再补`、`以后再补吧😅`、`以后再说————`、`待补…` 端到端全部 `exit=1 / M8=BLOCKED`；`待办列表点开就卡……`、`先暂停导入，等我确认口径再说`、`不改排序……只修列表`、`遇到数据冲突就停…`、`用户说「点开日历上的活就卡一下😅」` 等 15 条合法写法端到端全部 `exit=0 / M8=PASS`，未发现新误杀 | 无 |
| F1 | P3 | requirement_gap | `.agents/README.md:26` 仍写「`--selftest`：…覆盖正例、无契约、字段缺失、占位符、模块不拥有该文件、旧 epoch 兼容**六种情况**」，实测 `通过：26/26 个用例符合预期`；该行是 attempt 7 新加、本轮未触及（a7 与 a8 的 README 段落逐字相同）。纯文档口径，不影响判定 | 改成「26 条用例」或删掉数字（数量会变），无需再开一轮 |

## 证据重建与残余风险

- 重跑的命令、退出码与原始要点（完全本机实测）：
  1. 补丁一致性：`git diff HEAD -- .agents .githooks .github AGENTS.md _dev specs artifacts/runs/TASK-20261109-gate-hardening/{task.md,events.jsonl,evidence}` 的 stdout 为 **166072 字节，sha256 = `9949da1c2fc0f5a4bb9f3b2b37fe4dfa24b17df981964bdace55b0c0d680920c`**，与 delivery 的 `candidate_digest` 一致；`candidate-a8.patch` 与该 diff **byte-identical**（同长度、同 sha256）。`git diff HEAD -- server.js public/` 为空。
  2. `python .agents/gates/gate.py --selftest` → **exit 0，通过：26/26**。`placeholder_equivalence_class` 新增 4 条标点反例、2 条正例断言，仍锁住 attempt 5/6/7 的正反两侧。
  3. `node _dev/verify.mjs --full`（`CADENCE_BASE=http://127.0.0.1:8788`，本地服务 `node server.js`）→ **exit 0，8 项全绿 · 树 `f224ef334ec7aa31`（29 个代码文件 / 60 个文档）**，e2e 163，`契约门禁反面用例 26/26`——与 delivery 第 87-90 行逐项一致。
  4. `python .agents/gates/gate.py --fast --staged --repo .` → **exit 0**：M1 `15 protected staged paths`、M8 `受理五字段齐备`、M3 `5 blueprints updated`。
  5. `python .agents/gates/gate.py --ci --repo .` → **exit 0**：M1/M8/M3 `no protected path changed`、M2 `1 PASS events bound`、M4/M5/M6 PASS。
  6. 仓库外探针（真实 `gate.py --fast --staged`，每例重置基线，39 例）：attempt 7 的 4 条标点反例 + 我加的 `以后再补吧😅`/`以后再说————`/`待补…`/`以后再补吧……` 全部 `M8=BLOCKED`；attempt 6 的 9 条仍 `BLOCKED`；15 条合法写法（含带省略号的原话、含 emoji 的原话、`不改（待办）列表的排序逻辑`、写在 `## 受理` 第二小节）全部 `M8=PASS`。**无泄漏、无误杀。**
  7. 直调 `is_placeholder` 覆盖 27 条合法 + 27 条占位变体：`LEAK []`、`KILL []`。边缘标点归一没有把正常句子剥成占位词（`不改待办…`、`不改排序……只修列表`、`遇到数据冲突就停…` 均放行），括号摘除未误伤（`不改（待办）列表的排序逻辑` 放行），纯标点段（`……`、`！！`、` ， `）判占位符合预期。
  8. 本轮改动范围核对（a7 与 a8 候选补丁逐文件比对）：只有 `.agents/gates/gate.py` 变了（`PLACEHOLDER_EDGE` + `_placeholder_after_filler` 两处 + 6 条 selftest 断言），`.agents/README.md` 与 `.github/workflows/ai-native-gate.yml` 段落逐字相同，新增只有 `evidence/verdict-attempt7-fail.md` 与 `candidate-a8.patch`；产品代码零改动，未引入 M9/M7，`docs/adr/` 不存在。
- 与 Worker 证据的差异：`--selftest` 26/26、`--full` 8 项全绿（树 `f224ef334ec7aa31`、60 个文档、e2e 163）、`--fast --staged` 0、`--ci` 0、候选摘要，全部可复现，没有虚报；唯一偏差是 README 的「六种情况」与实际 26 条不符（F1/P3）。
- NOT_RUN 清单：none。`.githooks/pre-commit` 未整段执行，两条轨分别跑：`verify --hook` 由 `--full`/`--fast` 覆盖、`gate --fast --staged` exit 0。
- 残余风险（均为已披露的口径取舍，不构成本轮缺陷）：
  - 分段「全是占位词」才判占位，所以加一个正常分句仍能绕过：`以后再补吧，反正不急`（9 实字）实测放行。这是为了不误杀多段正常写法做的取舍。
  - 词表仍是枚举：`暂时不需要停`、`之后再补`、`待 定` 这类换词/拆字仍漏；兜底仍是复核。
  - `--ci` 只判 `HEAD~1...HEAD`，对新提交的拦截能力要等这次改动落成一次提交后再验。
  - 蓝图归属是自声明：新增一份具体 `paths:` 的蓝图即可在本次提交里自我授权（用户批准的口径，需蓝图评审兜底）。
  - `candidate-a8.patch` 等证据文件目前在索引里（`A`），`git add -A` 会一并提交。
- 判定理由：attempt 7 的唯一 finding 是「标点没纳入归一」，本轮用一处 `PLACEHOLDER_EDGE` 在每步比对前剥两端非文字字符、并把纯标点段判为无内容，端到端把我列出的 4 条反例与另外 4 条标点/emoji 变体全部拦住，同时 15 条合法写法（含省略号、emoji、括号、多段）零误杀，与 attempt 5/6/7 的三条回归线（误杀原话 → 语气词绕过 → 标点绕过）都不冲突。设计不需要再动，只余文档数字口径一条 P3。故判 **PASS**。
