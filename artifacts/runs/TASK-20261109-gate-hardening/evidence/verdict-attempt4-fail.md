<!-- `task submit --evidence <路径>` 必填；本文件由 Reviewer 人写，工具只校验与封存，不代写。 -->

# Verdict — TASK-20261109-gate-hardening（attempt 4）

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: TASK-20261109-gate-hardening
contract_version: 1
candidate_revision: 4
candidate_digest: 43957608215497511f7b9ecef5016cbf834e81e451a228a60fac3608071a1964
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
reviewer: Reviewer
reviewer_context: review-subagent-20261109-gate-hardening-a4
worker_context: planner-main-20261109-gate-hardening
attempt: 4
verdict: FAIL_IMPLEMENTATION
max_severity: P2
evidence_status: COMPLETE
not_run_count: 0
supersedes: 3

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明：本上下文是新开的 Reviewer 会话（`review-subagent-20261109-gate-hardening-a4`），未参与实现。只读仓库现状、契约、delivery、attempt 3 verdict（已归档 `evidence/verdict-attempt3-fail.md`）与候选补丁；先核对 `candidate-a4.patch` 的 sha256 = `43957608…1a1964`，与 delivery 一致。对抗探针建在 `%TEMP%\a2probe\repo4`（独立 git 仓库），用真实 `gate.py --fast --staged` 子进程执行；Cadence 仓库除本文件外未改动、未 `git add`/`commit`、8799 服务未停。
- 本轮逐条核对的实现：`gate.py` 的 `INTAKE_FIELDS`/`INTAKE_EPOCH=4`/`PLACEHOLDER_VALUE`/`INTAKE_MIN_SUBSTANCE`/`QUOTE_MARK`/`COMMAND_SHAPE`/`EXPECTED_RESULT`/`SCOPE_MARKER`/`STOP_MARKER`（L570-607）、`intake_problems()`（L619-645）、`check_m8()`（L648-686）、`parse_text()`（L144-160）、`blueprint_paths()` 的通配符过滤（L~400）、`run_selftest()` 的 16 个用例；`_dev/verify.mjs` 的三把摘要与 hook 绑定；`AGENTS.md` §2-§7；`.agents/templates/task.md`；`.agents/README.md`；真实契约 `artifacts/runs/TASK-20261109-gate-hardening/task.md` 的五个受理字段。
- 上轮 findings 的复核结论：`--full` 可复现（摘要口径）**保持修复**；`回头补`/`以后再补`/`待办`/`—`/`N/A`/无形状验收命令/无引号原话/`paths: *`/未跟踪蓝图扩权**全部被拦**。但 M8 改成了关键词形状规则后出现**新的误杀**（完整答案被 BLOCKED），见 Findings。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
| F1 | P2 | machine_gate_miss | M8 的「形状规则」把关键词存在当成内容合格，导致**语义完整、非占位符的受理字段被误杀**（真实模板版式探针，`modules: server-api` + 改 `server.js`）：① `out_of_scope: 本次范围限于工具与文档，M9 留待后续` → **M8 BLOCKED**「out_of_scope 要说清不做什么（含「不/无/仅/只/暂缓」）」；② `stop_conditions: 需要改动产品行为或数据模型时，先与用户确认再继续` → **M8 BLOCKED**「stop_conditions 要说清何时停（含「停/中止/上报/回退」）」；③ `stop_conditions: 口径不清时与用户确认` → 同样 **BLOCKED**。这三条都是「五问答完了」的正常答案，用户批准的口径是「缺一或为占位符 → BLOCKED」，没有批准「不含指定关键词就 BLOCKED」。对照：`stop_conditions: 不需要停止`、`out_of_scope: 不排除任何东西` 反而 PASS——同一套规则既误杀正常答案，又给否定式空话留门。摩擦会直接诱发 `--no-verify`（这正是 §7 拒绝 M9 的理由） | 把关键词从「必要条件」降为「占位符快速筛子」，主判定改成内容形状：`out_of_scope` 允许「本次范围限于…/留待后续/另开任务」等表述（或只要求非空 + 实质字数）；`stop_conditions` 接受「与用户确认/请示/沟通后继续」这类问人语义（`确认`、`请示`、`沟通`、`询问`）；并补三条正例 selftest（本次 B1/B2/B3）证明不过拦。若坚持关键词，则必须在模板里把这几个词写成硬性句式，并同步 `AGENTS.md` 的 M8 说明 |

## 证据重建与残余风险

- 重跑的命令、退出码与原始要点（全部本机实测）：
  1. `python .agents/gates/gate.py --selftest` → **exit 0，16/16**。逐条读过断言：`以后再补` 断言 M8 BLOCKED；`验收命令无期望结果`（`python .agents/selftest.py 看看`）断言 BLOCKED；`原话无引号` 断言 BLOCKED；`paths: *` 断言 M1 BLOCKED 且 M1 先红（`no declared module owns ['specs/modules/ghost.md']`）；`未跟踪蓝图` 断言 M1 BLOCKED；`Server.js` 断言仍受保护。用例都走真实子进程，不是打印通过；但正例只覆盖「含关键词」的写法，没有覆盖自然措辞。
  2. `$env:CADENCE_BASE='http://127.0.0.1:8799'; node _dev/verify.mjs --full` → **exit 0，8 项全绿，树 `1b67a03d6ffbca60`（29 个代码文件 / 52 个文档）**；**原地再跑一次仍 exit 0、摘要不变**。摘要口径保持上轮修复：写 `artifacts/` 不再改代码摘要。
  3. `python .agents/gates/gate.py --fast --staged --repo .` → **exit 0**：M1 `15 protected staged paths`、M8 `受理五字段齐备`、M3 `5 blueprints updated`。真实契约的五个字段（`「全量引入…」`/`不接 M9…`/`…期望退出码 0`/`…停下上报`）在新规则下仍放行，没有被误杀。
  4. `python .agents/gates/gate.py --ci --repo .` → **exit 0**：M1/M8/M3 `no protected path changed`、M2 `1 PASS events bound`、M4 `version authority: version.js`、M6 `2 snapshots verified`、M5 `0 dead links`。与上轮相同的语义空洞：`HEAD~1...HEAD` 是上一份 docs 提交，这次绿证明不了新提交会被拦。
  5. `node _dev/verify.mjs --hook`（写 verdict 前）→ **exit 0**，`这棵树跑过完整校验 · 1b67a03d6ffbca60`。
  6. 写本 `verdict.md` 后 `--hook` → **exit 1**（1/7，要求补 `--fast`）；`node _dev/verify.mjs --fast` → **exit 0**（6 项，树不变）；再 `--hook` → **exit 0**；最后 `--full` → **exit 0，8 项全绿，摘要仍 `1b67a03d6ffbca60`**。证据改动只动 `evidenceDigest`，已验证。
  7. `git diff HEAD -- server.js public/` → **空（长度 0）**；`docs/adr` 不存在；`AGENTS.md` §7 的 M9 暂缓、M7 不引入（只认 pytest、本项目用 e2e）、ADR 只写落点三条例外均保持；`gate.py` 无 M9/M7 实现。
- `%TEMP%\a2probe\repo4` 对抗探针（真实 `gate.py --fast --staged`，每例重置到基线提交）：
  - 正例：形状合规的基线契约 → **exit 0，M1/M8 PASS**；正常写法的范围外/停条件（`本次不做 M9；不改产品行为；不建 docs/adr` + `改到产品行为或数据模型时停下上报`）→ **exit 0 PASS**。
  - 上轮漏判的变体：`回头补`、`以后再补`、`待办`、`—`、`N/A` → **全部 M8 BLOCKED**；`acceptance_command: 跑一下看看` → BLOCKED（实质内容不足）、`python x.py 看看` → BLOCKED（缺期望结果）；`requirement_quote` 无引号 → BLOCKED（必须带引号）。上轮 F2 的列举项全部修好。
  - M1：暂存 `specs/modules/ghost.md` 写 `paths: *` → **M1 BLOCKED**（通配符视为没声明，`ghost.md` 自己没人认领）；未跟踪 `ghost.md` 作为唯一归属 → **M1 BLOCKED**（`no declared module owns ['server.js']`）。F3 与 `paths: *` 都修好。
  - 误杀：`本次范围限于工具与文档，M9 留待后续`、`需要改动产品行为或数据模型时，先与用户确认再继续`、`口径不清时与用户确认` → **全部 M8 BLOCKED**（Findings F1）。
- 与 Worker 证据的差异：delivery 贴的 `--selftest` 16/16、`--full` 8 项全绿（树 `1b67a03d6ffbca60`）、`--ci` 0、`--fast --staged` 0 全部可复现，`git diff server.js public/` 为空；「16 个用例」的清单也与其自述一致。差异只在结论：delivery 认为形状规则「拦空话且不误伤」，实测会误伤正常措辞。
- NOT_RUN 清单：none（`.githooks/pre-commit` 的 sh 包装未整段执行，分别跑了两条轨：`verify --hook` exit 0、`gate --fast --staged` exit 0）。
- 残余风险：
  - 关键词规则必然两头漏：`stop_conditions: 不需要停止`、`out_of_scope: 不排除任何东西`、`acceptance_command: node a.mjs 期望随便通过一下` 都能 PASS（否定词/「期望…通过」被当成合格证据）。delivery 的残余风险已承认「拦不住硬编一句看似具体的话」，本次复核确认这一点仍成立，不单列 finding。
  - `.agents/README.md` 仍写 `--selftest` 覆盖「六种情况」，实际已 16 条；delivery 声称同步了 README，但这段计数没跟上（P3 文档漂移，未单列 finding）。
  - 暂存区里有历史 `candidate-a1/a2/a3.patch`（A）与本轮 `candidate-a4.patch`（未跟踪），`verdict.md` 仍是 `AD`（索引留着旧内容）；提交必须 `git add -A`，否则会把旧 attempt 的 verdict 内容提交进去。
  - `--ci` 在本仓库仍只判 `HEAD~1...HEAD`，对新提交的拦截能力要等这次改动落成一次提交后再验。
  - 蓝图归属仍是自声明：新增一份具体 `paths: server.js` 的蓝图即可在本次提交里「自我授权」。属用户批准的「蓝图声明归属」口径，不判 finding，但需要蓝图评审兜底。
- 判定理由：上一轮的四个问题（`--full` 可复现、词表漏判、工作区回退、`paths: *`）都已实测修好，M1 侧没有新的缺口，验收命令全部可复现地绿。剩下的是 M8 从一个极端走到另一个极端：词表换成了关键词形状规则，能拦住「以后再补」「跑一下看看」，却把「本次范围限于…，M9 留待后续」「改动产品行为前先与用户确认」这类**答完了的正常答案**判成 BLOCKED。用户批准的口径是「缺一或为占位符 → BLOCKED」，误杀正常答案是语义偏差，且这种摩擦正是 `--no-verify` 的诱因，因此判 `FAIL_IMPLEMENTATION / P2`。修改面很小（关键词降为筛子 + 补问人/范围语义 + 三条正例 selftest），不需要动整体设计。
