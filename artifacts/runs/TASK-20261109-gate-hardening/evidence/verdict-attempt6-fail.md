<!-- `task submit --evidence <路径>` 必填；本文件由 Reviewer 人写，工具只校验与封存，不代写。 -->

# Verdict — TASK-20261109-gate-hardening（attempt 6）

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: TASK-20261109-gate-hardening
contract_version: 1
candidate_revision: 6
candidate_digest: d867c0def30ddc35229b0baf61ca1443fbfcf67f4b23611a5dca2e4a61df6cb7
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
reviewer: Reviewer
reviewer_context: review-subagent-20261109-gate-hardening-a6
worker_context: planner-main-20261109-gate-hardening
attempt: 6
verdict: FAIL_IMPLEMENTATION
max_severity: P2
evidence_status: COMPLETE
not_run_count: 0
supersedes: 5

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明：本上下文是新开的 Reviewer 会话（`review-subagent-20261109-gate-hardening-a6`），未参与实现，未读实现过程的私有推理，只读仓库现状、`task.md`、attempt 6 `delivery.md`、attempt 5 verdict（已归档 `evidence/verdict-attempt5-fail.md`）与候选补丁。先核对 `candidate-a6.patch` 的 sha256 = `d867c0de…61df6cb7`，与 delivery 声明一致。对抗探针建在 `%TEMP%\a2probe\repo6`（独立 git 仓库，未污染 Cadence），用真实 `gate.py --fast --staged` 子进程执行；Cadence 仓库本轮只写本文件，未改代码/契约、未 `git add`/`commit`、未删文件、8799 服务未停。
- 本次读取的项目权威：`AGENTS.md` §2-§7、`.agents/templates/{task,verdict}.md`、`.agents/README.md`、`artifacts/runs/TASK-20261109-gate-hardening/{task.md,delivery.md}`、`.agents/gates/gate.py`（`is_placeholder` L583-598、`intake_problems` L633-653、`check_m8`）。
- 已核对的 Task Contract 与 delivery 摘要：验收命令为 `node _dev/verify.mjs --full`（期望退出码 0）与 `gate.py --fast --staged`（期望 0）；本版声称「删除子串匹配、改为整值/全分段匹配」并新增 3 条正例 selftest 至 24 条。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
| F1 | **P2** | machine_gate_miss | 占位符改为「整值/全分段完全相等」后，只要加一个语气词或一层括号就能整句绕过；这是本轮改动引入的**回归**（attempt 5 的子串匹配能拦这些）。探针 `%TEMP%\a2probe\repo6`（真实模板版式、`modules: server-api`、改 `server.js`、其余四字段合规，每例重置到基线提交），下列输入 `exit=0 / M8=PASS / 受理五字段齐备`：① `out_of_scope: 以后再补吧`（5 字，实质字数阈值 4 也过了）；② `out_of_scope: 回头再补一下`；③ `out_of_scope: 待定一下`；④ `out_of_scope: 看情况吧`；⑤ `out_of_scope: 暂无内容`；⑥ `out_of_scope: 以后再说吧`；⑦ `out_of_scope: TBD（待补）`；⑧ `out_of_scope: 待办（回头再补）`；⑨ `stop_conditions: 暂时不需要停止`。直接调用也证实：`is_placeholder('以后再补吧') = False`、`is_placeholder('待办（回头再补）') = False`、`is_placeholder('暂时不需要停止') = False`。对照组（仍然拦，证明探针有效）：`待定，回头再补`、`TBD 稍后补`、`以后再补`、`待办`、`稍后`、`随便`、`—`、`N/A`、`不需要停止`、`不排除任何东西`、`以后再补。`、`待定、回头再补`、`待定 / 回头再补`、`暂无` 全部 `M8=BLOCKED`；`都行吧` 被实质字数规则拦（3 字 < 4），不是占位符规则拦的。delivery 声称「M8 的形状规则能拦『以后再补』『看情况』这类空话」，对该类空话的日常写法（加「吧/一下/（待补）」）并不成立 | 在 `is_placeholder` 的每一段比较前做一次**归一**再比对词集合：①去掉尾部语气/收束词（`吧 呢 啊 了 呀 哦 嘛 先 再说` 可重复剥离）；②整段形如 `<占位词>（…）/（…）/【…】/[…]` 时剥掉括号补注后再比对；③归一后仍为空或仍等于占位词 → 占位。这样 `以后再补吧`/`待定一下`/`看情况吧`/`暂无内容`/`TBD（待补）`/`待办（回头再补）`/`暂时不需要停止` 会被拦，而 `待办列表点开就卡，先修这个`（不等于占位词、首段不是「占位词+语气词」）和 `不改待办排序` 不受影响。补 selftest：上述 9 条改成反例断言；保留本轮新增的 `原话含待办`/`停条件含稍后` 正例与 `待办`/`稍后`/`随便` 整值反例，锁住两侧 |

## 证据重建与残余风险

- 重跑的命令、退出码与原始要点（完全本机实测）：
  1. `Get-FileHash candidate-a6.patch -Algorithm SHA256` → `D867C0DEF30DDC35229B0BAF61CA1443FBFCF67F4B23611A5DCA2E4A61DF6CB7`，与任务给定值、delivery 一致。
  2. `python .agents/gates/gate.py --selftest` → **exit 0，24/24**。逐条看过：M1 正例/摘要漂移/模块不拥有/只覆盖部分/未跟踪蓝图/`paths: *`/`Server.js` 都在；M8 反例 `停条件空`、`<待填>`、`TBD 稍后补`、`待定，回头再补`、`以后再补`、`不排除任何东西`、`不需要停止`、`—`、验收命令无期望结果、原话无引号都在；正例 `范围限于工具，留待后续`、`先与用户确认再继续`、`口径不清时与用户确认`、`原话含待办`、`停条件含稍后` 确实断言放行。与上轮相同，用例集没有覆盖「占位词 + 语气词/括号」形态，所以没发现 F1。
  3. `$env:CADENCE_BASE='http://127.0.0.1:8799'; node _dev/verify.mjs --full` → **exit 0，8 项全绿，树 `1b67a03d6ffbca60`（29 个代码文件 / 56 个文档）**，e2e 163。
  4. `python .agents/gates/gate.py --fast --staged --repo .` → **exit 0**：M1 `15 protected staged paths`、M8 `受理五字段齐备`、M3 `5 blueprints updated`。
  5. `python .agents/gates/gate.py --ci --repo .` → **exit 0**：M1/M8/M3 `no protected path changed`、M2 `1 PASS events bound`、M4、M6、M5 全 PASS（与往轮相同的语义空洞：只判 `HEAD~1...HEAD`）。
  6. `node _dev/verify.mjs --hook`（写本文件前）→ **exit 0**，`7 项全绿 · 1b67a03d6ffbca60（56 个文档）`。
  7. `git diff HEAD -- server.js public/` → **空**；`git status --short` 只有工具/文档/证据面改动（`.agents/*`、`.githooks`、`.github/workflows`、`AGENTS.md`、`_dev/verify.mjs`、`specs/modules/*`、`artifacts/runs/*`），无产品代码；`docs/adr` 不存在；`AGENTS.md` §7 的 M9 暂缓、M7 不引入、ADR 只写落点三条例外保持；`gate.py` 无 M9/M7 实现。
- `%TEMP%\a2probe\repo6` 对抗探针（真实 `gate.py --fast --staged`，每例重置到基线提交）：
  - 上轮 6 条可复现输入（本轮 F1 的对象）**全部放行**：`requirement_quote: 用户说「待办列表点开就卡，先修这个」`、`user_problem: 用户在待办列表里看不到逾期标记，误判成没到期`、`out_of_scope: 不改待办事项的排序与颜色，不接 M9`、`stop_conditions: 待办数据冲突时停下上报`、`out_of_scope: 不允许随便改动产品行为`、`requirement_quote: 用户说「列表稍后加载完再显示也行」` → 均 `exit=0 M1=PASS M8=PASS`。**attempt 5 的 P1 已修复**。
  - 必须拦的 12 条反例 + `paths: *`（含用 `tooling` 覆盖蓝图自身）+ 未跟踪蓝图唯一归属 → 全部 `exit=1`，M8 或 M1 BLOCKED，符合要求。
  - 误杀回归 5 条（`不改待办排序，不做稍后提醒`、`范围限于工具…M9 留待后续`、`需要改动产品行为时，先与用户确认再继续`、`列表稍后加载时页面空白…`、`不改 public/ 与 server.js`）→ 全部放行。
  - 新增边界探针 14 条 → 5 条仍拦（`都行吧` 因字数、`以后再补。`、`待定、回头再补`、`待定 / 回头再补`、`暂无`），9 条漏拦（即 F1 的 ①②③④⑤⑥⑦⑧⑨）。
- 与 Worker 证据的差异：delivery 贴的 `--selftest` 24/24、`--full` 8 项全绿（树 `1b67a03d6ffbca60`、e2e 163）、`--fast --staged` 0、`--ci` 0、`git diff server.js public/` 为空全部可复现，没有虚报。差异只在结论口径：它把「整值匹配」当成已经关掉占位符闸，但该闸对「占位词 + 语气词/括号」整类输入不生效。
- NOT_RUN 清单：none（`.githooks/pre-commit` 的 sh 包装未整段执行，分别跑了两条轨：`verify --hook` exit 0、`gate --fast --staged` exit 0）。
- 残余风险：
  - 词表本质是枚举，本轮 F1 是「完全相等」这一端的必然缺口；归一化只能把常见变体收进来，兜底仍是复核。
  - `--ci` 只判 `HEAD~1...HEAD`，对新提交的拦截能力要等这次改动落成一次提交后再验。
  - 蓝图归属是自声明：新增一份具体 `paths:` 的蓝图即可在本次提交里自我授权（用户批准的口径，需蓝图评审兜底）。
  - `git status --short` 里 `artifacts/runs/TASK-20261109-gate-hardening/verdict.md` 是 `AD`（索引里有 attempt 5 的内容、工作区已被归档删除），提交必须 `git add -A`；另有 `candidate-a6.patch`、`evidence/verdict-attempt5-fail.md` 尚未进索引。
  - `.agents/README.md` 第 26 行仍写 `--selftest` 覆盖「六种情况」，实际 24 条（上轮已记为残余风险，文档面、不影响判定）。
- 判定理由：attempt 5 的 P1 已经修好——6 条合法原话/停条件实测全部放行，误杀回归 5 条也全部放行，这是本轮的主要目标，达成了。但修复方式只覆盖了「整值完全相等」，词表旁多一个「吧」或一层括号就不再拦：`out_of_scope: 以后再补吧`、`看情况吧`、`待定一下`、`暂无内容`、`TBD（待补）`、`待办（回头再补）`、`stop_conditions: 暂时不需要停止` 实测全部 `M8=PASS / exit 0`。这是 attempt 5 子串匹配能拦住、本轮改成整值后漏掉的行为，属于本轮引入的回归，且正落在用户批准的「受理字段为占位符 → BLOCKED」这条要求上，不是新的加码。修法很小（每段比对前剥尾部语气词与括号补注），因此仍判 `FAIL_IMPLEMENTATION / P2`：整体设计不需要动，只要把占位符判定补到「整值等价类」而不是「字面完全相同」。
