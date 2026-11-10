<!-- `task submit --evidence <路径>` 必填；本文件由 Reviewer 人写，工具只校验与封存，不代写。 -->

# Verdict — TASK-20261109-gate-hardening（attempt 7）

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: TASK-20261109-gate-hardening
contract_version: 1
candidate_revision: 7
candidate_digest: f6a7752c8f3e531b587dcee3d50091a61a63f0e8f59ab74368fa644d6d8c1b1e
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
reviewer: Reviewer
reviewer_context: review-subagent-20261109-gate-hardening-a7
worker_context: planner-main-20261109-gate-hardening
attempt: 7
verdict: FAIL_IMPLEMENTATION
max_severity: P2
evidence_status: COMPLETE
not_run_count: 0
supersedes: 6

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明：复核方式为**新开一轮对话的独立子代理**（`review-subagent-20261109-gate-hardening-a7`），未参与实现、未读实现过程的私有推理，只读仓库现状、`task.md`、attempt 7 `delivery.md`、attempt 6 verdict（`evidence/verdict-attempt6-fail.md`）与候选补丁。**复核对象：树摘要 `f224ef334ec7aa31`**（本机 `--full` 实测），候选补丁 sha256 = `f6a7752c…d8c1b1e`，与 delivery 声明一致。对抗探针建在仓库外 `%TEMP%\a7probe\repo`（独立 git 仓库，未污染 Cadence），用真实 `gate.py --fast --staged` 子进程执行；Cadence 仓库本轮只新增本文件，未改代码/契约、未 `git add`/`commit`、未删文件。
- 本次读取的项目权威：`AGENTS.md` §2-§7、`.agents/templates/{task,delivery,verdict}.md`、`.agents/README.md`、`artifacts/runs/TASK-20261109-gate-hardening/{task.md,delivery.md}`、`.agents/gates/gate.py`（`PLACEHOLDER_*` L583-630、`intake_problems` L665-685、`check_m8`、`_selftest_repo`）、`.github/workflows/ai-native-gate.yml`。
- 已核对的 Task Contract 与 delivery 摘要：验收命令为 `node _dev/verify.mjs --full`（期望 0）、`gate.py --selftest`（期望 0）、`gate.py --ci --repo .`（期望 0），契约五字段齐备、`gate_level: G2`、`base_revision` 与 HEAD 一致。本版声称「占位符判到等价类（先摘括号、再从两端剥语气词，每步重比词表）」「`--selftest` 26 条」「CI job 名写 `gate (M1-M8; M9 未启用)`」，逐条复跑结论见下。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
| F1 | **P2** | machine_gate_miss | attempt 6 的 9 条等价类用例确实堵住了（端到端全部 `M8=BLOCKED`），但**归一化只去语气词、不去标点**，同一句占位词加一个省略号/波浪号仍整句放行；这是 F1 所要求「等价类归一」未做完，不是新的词形。探针 `%TEMP%\a7probe\repo`（真实模板版式、`modules: server-api`、改 `server.js`、其余四字段合规，每例重置到基线提交）：`out_of_scope: 以后再补…` → `exit=0`、M8 `TASK-PROBE-A7 受理五字段齐备`、`"status": "pass"`；同样放行的还有 `以后再补吧～`（5 字）、`待办（回头再补）…`、`待定…，回头再补`（6 字）。直调 `is_placeholder` 另见 `以后再补…`/`以后再补吧…`/`待定~`/`待补…`/`以后再补吧:)`/`以后再补吧😅` 均为 `False`。根因：`is_placeholder` 的整值/分段剥离集合只有 `。.!！?？；;，, 「空格」`（L621），语气词表只有汉字（L596-599），`_placeholder_after_filler` 只按词表前后缀剥，所以 `…`/`～`/`—`/emoji 停在两端，永远剥不到占位词；且标点归一只在整值上做一次，分段内的 `待定…` 也过不去。对照组（证明探针有效、F1 的 9 条已修好）：`以后再补吧`、`回头再补一下`、`待定一下`、`看情况吧`、`暂无内容`、`以后再说吧`、`TBD（待补）`、`待办（回头再补）`、`暂时不需要停止` 全部 `exit=1`、M8 `BLOCKED`；`待定……`、`TBD…` 被拦是实质字数 <4 而非占位符规则（`待定…` 只有 2 个实字），换成 4 字以上就漏。delivery 第 43 行与「改动前 vs 改动后」表把这一类标成已关，与实测不符 | 在 `_placeholder_after_filler` 每次比对前先剥两端非文字字符（`current = re.sub(r"^[\W_]+|[\W_]+$", "", current, flags=re.UNICODE)`），使 `…`/`～`/`—`/`:)`/emoji 与汉字语气词等价；由于该函数已按分段调用，分段内的 `待定…` 一并解决。selftest 的 `must_block` 补 `以后再补…`、`以后再补吧～`、`待定…，回头再补`、`待办（回头再补）…`，端到端用例改/加一条 4 字以上的带省略号写法（如 `out_of_scope: 以后再补…`），避免只靠字数规则兜住 |
| F2 | P3 | requirement_gap | 本轮新加的 `.agents/README.md` 门禁小节写「`--selftest`：…覆盖正例、无契约、字段缺失、占位符、模块不拥有该文件、旧 epoch 兼容**六种情况**」，而实测是 `通过：26/26 个用例符合预期`。attempt 6 的 verdict 已把「六种情况」记为文档过期项，本轮重写这几行时沿用了旧口径 | 改成「26 条用例」或直接不写数量（数字会变，写「覆盖 M1/M8 的反例与正例」即可） |

## 证据重建与残余风险

- 重跑的命令、退出码与原始要点（完全本机实测）：
  1. 补丁一致性：`git diff HEAD -- .agents .githooks .github AGENTS.md _dev specs artifacts/runs/TASK-20261109-gate-hardening/{task.md,events.jsonl,evidence}` 的 stdout 字节 **152827 字节，sha256 = `f6a7752c8f3e531b587dcee3d50091a61a63f0e8f59ab74368fa644d6d8c1b1e`**，与 delivery 的 `candidate_digest` 逐字节相同；`candidate-a7.patch` 与该 diff **byte-identical**（同样 152827 字节、同 sha256）。`git diff HEAD -- server.js public/` 为空。
  2. `python .agents/gates/gate.py --selftest` → **exit 0，通过：26/26**。逐条看过：F1 的 9 条与「+语气词/+括号」用例在 `placeholder_equivalence_class` 里，端到端 `以后再补吧` 在 `placeholder_tone_word` 里；正例 `范围限于工具…`、`先与用户确认…`、`口径不清…`、`原话含待办`、`停条件含稍后` 都断言放行。用例集没有覆盖「占位词 + 尾部标点」，所以 F1 残留没被发现。
  3. `node _dev/verify.mjs --full`（先起本地服务 `node server.js`，`CADENCE_BASE=http://127.0.0.1:8788`）→ **exit 0，8 项全绿 · 树 `f224ef334ec7aa31`（29 个代码文件 / 58 个文档）**，e2e 163，`契约门禁反面用例 26/26`。与 delivery 的「验证证据」一致；也再次确认「写 delivery/verdict 不改代码摘要」这条 (#64) 成立。
  4. `python .agents/gates/gate.py --fast --staged --repo .` → **exit 0**：M1 `15 protected staged paths`、M8 `受理五字段齐备`、M3 `5 blueprints updated`。
  5. `python .agents/gates/gate.py --ci --repo .` → **exit 0**：M1/M8/M3 都是 `no protected path changed`、M2 `1 PASS events bound`、M4/M5/M6 PASS。与往轮相同的语义空洞：只判 `HEAD~1...HEAD`，证明不了新路径上的拦截能力。
  6. 仓库外探针（真实 `gate.py --fast --staged`，每例重置基线）：合法写法 8 条全部 `exit=0 M8=PASS`——`不改待办事项的排序与颜色，不接 M9`、`本次范围限于工具与文档，M9 留待后续`、`先不做，等口径`、`不改 public/（含 app.js）`、`暂停功能不接，只修列表`、`稍后发现数据不对就立即停止并上报`、`用户说「待办列表点开就卡，先修这个」`、写在 `## 受理` 第二小节的 `不改待办排序`。**F1 修好，且方向没跑偏：没有误杀**。
  7. 误杀面另测：直接对 29 条本产品真实口吻的原话/停条件/范围描述调 `is_placeholder`（含 `先停一下，等用户确认再动`、`取消勾选后不该再冒出来，这次先不动它`、`不看情况，一律按用户原话判`、`不改（待办）列表的排序逻辑`、`订阅到期后先停同步，等人工确认` 等）→ **0 条被判占位**；对仓库里 10 份真实 `task.md`/归档契约/模板扫描受理字段 → 仅模板里的 `<用户原话…>` 等占位文本被判占位（应拦），无合法值被误杀。结论：`_placeholder_after_filler` 的「从两端剥 + 每步重比词表」没有把正常句子剥成占位词，括号摘除也只影响「摘完正好剩占位词」的写法（`不改待办（排序）` 仍放行）。
  8. 本轮改动范围核对（`candidate-a6.patch` 与 `candidate-a7.patch` 逐文件比对）：只动了 `.agents/gates/gate.py`（`PLACEHOLDER_PARENS`/`PLACEHOLDER_FILLERS`/`_placeholder_after_filler` + 2 条 selftest）、`.github/workflows/ai-native-gate.yml`（job 名 → `gate (M1-M8; M9 未启用)`）、`.agents/README.md` 与新增的 attempt 6 归档 verdict。未引入 M9/M7，`docs/adr/` 不存在，产品代码零改动。
- 与 Worker 证据的差异：`--selftest` 26/26、`--full` 8 项全绿（树 `f224ef334ec7aa31`、e2e 163）、`--fast --staged` 0、`--ci` 0、`git diff server.js public/` 为空、候选摘要，全部可复现，没有虚报。差异只在结论口径：它把「占位词 + 语气词/括号补注」当成了完整的等价类，实测还差「尾部标点/emoji」这一支（F1）；README 的「六种情况」与实际 26 条不符（F2）。
- 环境注记（非本次改动）：`--full` 的服务检查用 `fetch('http://localhost:8788')`，本机 Node 走 `localhost` 连不上（服务在跑也不行），需 `CADENCE_BASE=http://127.0.0.1:8788` 才是绿；这是既有行为，与 attempt 7 无关，但会让人误以为「绿不了」。
- NOT_RUN 清单：none。`.githooks/pre-commit` 未整段执行，两条轨分别跑：`verify --hook` 由 `--full` 覆盖、`gate --fast --staged` exit 0。
- 残余风险：
  - 词表 + 归一本质是枚举：本轮补上标点后，换个没列进词表的说法（`过两天写`、`暂时不需要停`、`之后再补`）仍会漏；真正兜底仍是复核。这是交付已披露的口径，属可接受。
  - `all(部分都是占位词)` 的设计必然允许「加一个正常分句」绕过：`以后再补吧，反正不急`（9 实字）实测 `is_placeholder=False`。这条是为了不误杀 `待定，回头再补` 之外的多段正常写法而做的取舍，与上面的枚举风险同级。
  - `--ci` 只判 `HEAD~1...HEAD`，对新提交的拦截能力要等这次改动落成一次提交后再验。
  - 蓝图归属是自声明：新增一份具体 `paths:` 的蓝图即可在本次提交里自我授权（用户批准的口径，需蓝图评审兜底）。
  - 提交时注意：`candidate-a7.patch` 目前仍是未跟踪文件（`??`），`git add -A` 会把它纳入。
- 判定理由：attempt 6 的 F1 指名的那 9 条端到端全部 `M8=BLOCKED`，同时 8 条合法写法全部 `M8=PASS`、29 条真实口吻原话零误杀、括号摘除未误伤——本轮的主要目标达成，方向也对（不再加语义判词）。但「等价类」只覆盖了汉字语气词与括号，**同一句占位词带一个常用的尾部省略号/波浪号就能整句通过**：`out_of_scope: 以后再补…` 实测 `exit=0`、M8 `受理五字段齐备`。这不是「换个没列进词表的说法」，而是 F1 要求的归一步骤没做完，且 delivery 明确宣称该类已关闭。修法是一处归一（两端非文字字符），不需要动设计，故判 `FAIL_IMPLEMENTATION / P2`，而不是打回重做。
