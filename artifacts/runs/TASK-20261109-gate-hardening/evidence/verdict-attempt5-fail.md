<!-- `task submit --evidence <路径>` 必填；本文件由 Reviewer 人写，工具只校验与封存，不代写。 -->

# Verdict — TASK-20261109-gate-hardening（attempt 5）

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: TASK-20261109-gate-hardening
contract_version: 1
candidate_revision: 5
candidate_digest: 1599ceaf5fdd3b9190bebbce1af72893a2cc59314d305f01004508894a7be44b
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
reviewer: Reviewer
reviewer_context: review-subagent-20261109-gate-hardening-a5
worker_context: planner-main-20261109-gate-hardening
attempt: 5
verdict: FAIL_IMPLEMENTATION
max_severity: P1
evidence_status: COMPLETE
not_run_count: 0
supersedes: 4

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明：本上下文是新开的 Reviewer 会话（`review-subagent-20261109-gate-hardening-a5`），未参与实现。只读仓库现状、契约、delivery、attempt 4 verdict（已归档 `evidence/verdict-attempt4-fail.md`）与候选补丁；先核对 `candidate-a5.patch` 的 sha256 = `1599ceaf…8a7be44b`，与 delivery 一致。对抗探针建在 `%TEMP%\a2probe\repo5`（独立 git 仓库），用真实 `gate.py --fast --staged` 子进程执行；Cadence 仓库除本文件外未改动、未 `git add`/`commit`、8799 服务未停。
- 本轮逐条核对的实现：`gate.py` 的占位词表 `PLACEHOLDER_VALUE`（L579-585）、`INTAKE_MIN_SUBSTANCE`（L589-595）、`QUOTE_MARK`/`COMMAND_SHAPE`/`EXPECTED_RESULT`/`SUBSTANCE`（L596-606）、`intake_problems()`（L618-638）、`check_m8()`、`run_selftest()` 的 21 个用例；`_dev/verify.mjs` 的三把摘要与 hook 绑定；`AGENTS.md` §2-§7；`.agents/templates/task.md`；`README.md` / `.agents/SPEC.md` 的领域用词。
- 上轮 findings 的复核结论：attempt 4 的误杀**已修**——`范围限于工具与文档，M9 留待后续`、`先与用户确认再继续`、`口径不清时与用户确认` 三条实测全部放行；`不排除任何东西`、`不需要停止` 等反例全部被拦；`paths: *`、未跟踪蓝图仍被 M1 拦；摘要口径保持可复现。**新问题是同一张词表的匹配方式**（无锚点子串匹配）撞上了产品自己的核心名词，见 Findings。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
| F1 | **P1** | machine_gate_miss | `PLACEHOLDER_VALUE.search(value)` 是无锚点子串匹配，词表里的 `待办` / `稍后` / `随便` 恰好是本产品的日常用词（`README.md` 出现「待办」4 次、`.agents/SPEC.md` 2 次，`待办` 是核心对象之一）。真实模板版式探针（`modules: server-api` + 改 `server.js`，其余字段合规），只要任意一个受理字段的自然表述里带这些词就被判成占位符并 BLOCKED：① `requirement_quote: 用户说「待办列表点开就卡，先修这个」` → **M8 BLOCKED**「requirement_quote 仍是占位符」；② `user_problem: 用户在待办列表里看不到逾期标记，误判成没到期` → **BLOCKED**；③ `out_of_scope: 不改待办事项的排序与颜色，不接 M9` → **BLOCKED**；④ `stop_conditions: 待办数据冲突时停下上报` → **BLOCKED**；⑤ `out_of_scope: 不允许随便改动产品行为` → **BLOCKED**；⑥ `requirement_quote: 用户说「列表稍后加载完再显示也行」` → **BLOCKED**。①⑥ 尤其致命：AGENTS §4 规定 `requirement_quote` 必须是「用户原话，不改写」，用户谈待办功能时原话必然含「待办」——守规矩就 BLOCKED，想通过只能改写用户原话（违反同一条规矩）或 `--no-verify`，即整个「待办/任务域」的 G1+ 任务没有合法通过路径 | 占位符改为**整值匹配**而非子串匹配：先 `strip()` + 去尾部标点，再与词表做完全相等比较（可保留「整值以 `待定|待办|…` 开头且长度 ≤ N」这一条边界），不要对任意长句做 `search`；`待办`/`稍后`/`随便` 这类多义常用词只在整值时才算占位符。补正例 selftest：上面 ①②③④ 四条必须放行，同时保留 `out_of_scope: 待办`、`稍后`、`以后再补` 的整值反例 |

## 证据重建与残余风险

- 重跑的命令、退出码与原始要点（完全本机实测）：
  1. `python .agents/gates/gate.py --selftest` → **exit 0，21/21**。逐条看过输出与断言：M1 正例/摘要漂移/模块不拥有/只覆盖部分/未跟踪蓝图/`paths: *`/`Server.js` 都在；M8 反例（停条件空、`<待填>`、`TBD 稍后补`、`待定，回头再补`、`以后再补`、`不排除任何东西`、`不需要停止`、验收命令无期望结果、原话无引号）都在；本轮新增的三条正例（`范围限于工具，留待后续`、`先与用户确认再继续`、`口径不清时与用户确认`）确实断言放行。不是打印通过。但它没有覆盖「合规长句里出现词表词」这一形态，所以没发现 F1。
  2. `$env:CADENCE_BASE='http://127.0.0.1:8799'; node _dev/verify.mjs --full` → **exit 0，8 项全绿，树 `1b67a03d6ffbca60`（29 个代码文件 / 54 个文档）**，e2e 163；**原地再跑一次仍 exit 0、摘要不变**（#64 口径保持）。
  3. `python .agents/gates/gate.py --fast --staged --repo .` → **exit 0**：M1 `15 protected staged paths`、M8 `受理五字段齐备`、M3 `5 blueprints updated`。
  4. `python .agents/gates/gate.py --ci --repo .` → **exit 0**：M1/M8/M3 `no protected path changed`、M2 `1 PASS events bound`、M4、M6、M5 全 PASS。与往轮相同的语义空洞（只判 `HEAD~1...HEAD`，即上一份 docs 提交）。
  5. `node _dev/verify.mjs --hook`（写 verdict 前）→ **exit 0**，`7 项全绿 · 1b67a03d6ffbca60`。
  6. 写本 `verdict.md` 后 `--hook` → **exit 1**（1/7，要求补 `--fast`）；`--fast` → **exit 0**（6 项，树不变）；再 `--hook` → **exit 0**（7 项全绿，55 个文档）；最后 `--full` → **exit 0，8 项全绿，摘要仍 `1b67a03d6ffbca60`**。证据改动只动 `evidenceDigest`，已验证。
  7. `git diff HEAD -- server.js public/` → **空（长度 0）**；`git status --short` 只有工具/文档/证据面改动（`.agents/*`、`.githooks`、`.github/workflows`、`AGENTS.md`、`_dev/verify.mjs`、`specs/modules/*`、`artifacts/runs/*`），无产品代码；`docs/adr` 不存在；`AGENTS.md` §7 的 M9 暂缓、M7 不引入（只认 pytest，本项目用 e2e）、ADR 只写落点三条例外均保持；`gate.py` 无 M9/M7 实现。
- `%TEMP%\a2probe\repo5` 对抗探针（真实 `gate.py --fast --staged`，每例重置到基线提交）：
  - 必须放行：基线 → **exit 0 M1/M8 PASS**；`本次范围限于工具与文档，M9 留待后续` → **PASS**；`需要改动产品行为或数据模型时，先与用户确认再继续` → **PASS**；`口径不清时与用户确认` → **PASS**（attempt 4 的误杀已消失）。
  - 必须拦：`以后再补`/`待办`/`回头补`/`不需要停止`/`不排除任何东西`/`—`/`N/A` → **M8 BLOCKED**；`python x.py 看看` → **BLOCKED（缺期望结果）**；原话无引号 → **BLOCKED**；暂存 `paths: *` 蓝图（含用 `tooling` 覆盖蓝图自身的情形）→ **M1 BLOCKED**；未跟踪蓝图作为唯一归属 → **M1 BLOCKED**。全部符合要求。
  - 领域用词探针（Findings F1）：上表 ①-⑥ 六条合规长句 → **全部 M8 BLOCKED**，提示语均为「〈字段〉仍是占位符」。
- 与 Worker 证据的差异：delivery 贴的 `--selftest` 21/21、`--full` 8 项全绿（树 `1b67a03d6ffbca60`）、`--ci` 0、`--fast --staged` 0、`git diff server.js public/` 为空**全部可复现**；它声称「撤掉语义判词后不再误杀」只对上一轮点名的三种写法成立，对搬进词表的 `待办`/`稍后`/`随便` 仍然误杀。
- NOT_RUN 清单：none（`.githooks/pre-commit` 的 sh 包装未整段执行，分别跑了两条轨：`verify --hook` exit 0、`gate --fast --staged` exit 0）。
- 残余风险：
  - 词表无论怎么补都是枚举：这次是「多义常用词被整句子串命中」，下次可能是别的词；彻底的兜底仍靠复核。但整值匹配能消掉当前这一类。
  - `--ci` 只判 `HEAD~1...HEAD`，对新提交的拦截能力要等这次改动落成一次提交后再验。
  - 蓝图归属是自声明：新增一份具体 `paths:` 的蓝图即可在本次提交里自我授权（用户批准的口径，需蓝图评审兜底）。
  - 索引里仍有上一轮的 `artifacts/runs/TASK-20261109-gate-hardening/verdict.md`（`AD`）与历史 `candidate-a1..a4.patch`；提交必须 `git add -A`，否则会把旧 attempt 的 verdict 内容提交进去。
  - `.agents/README.md` 的 `--selftest` 描述是否同步到 21 条未逐字核对（文档面，不影响判定）。
- 判定理由：attempt 1-4 的问题都收敛了：M1 的受保护面/归属/通配符/未跟踪蓝图、M8 的跨小节解析与占位符、`--full` 的可复现性，实测全部成立，产品代码零改动。但 M8 的占位符匹配是无锚点子串，词表里的 `待办` 正是本产品的核心名词（README/SPEC 都在用），而 `requirement_quote` 又规定必须是用户原话——用户谈待办时原话必然命中词表，于是「待办/任务域」的 G1+ 任务守规矩就 BLOCKED、想通过只能改原话或 `--no-verify`。这不是「写得朴素」，是没有合法通过路径，因此判 `FAIL_IMPLEMENTATION / P1`。修改面很小：占位符改整值匹配 + 四条正例 selftest，不需要动整体设计。
