# Verdict 纪要 — TASK-20261110-auth-export

> **这不是一份复核签署。** 本文件由实现方整理，来源是**两轮独立复核**已经给出的结论：
> 第一轮（0.9.0 交付时）通过；第二轮（2026-11-11）**FAIL**，卡在门禁自身。
> 第三轮的独立结论应由没参与实现的上下文另写并覆盖本文件；在此之前，本任务停在
> `READY_FOR_REVIEW`，没有 PASS 事件，也没有 `task done`。

## 身份（机器读）

task_id: TASK-20261110-auth-export
contract_version: 3
candidate_revision: 1
candidate_digest: 未封存（候选由第三轮复核按提交号封存）
base_revision: 41b9ae2
reviewer: 两轮独立复核（非本文件作者）
reviewer_context: 独立复核会话（第一轮、第二轮各一次，session id 未在本仓库登记）
worker_context: 实现会话（本文件作者）
attempt: 2
verdict: 未签署（第一轮 PASS / 第二轮 FAIL，结论见下；第三轮待出）
max_severity: P1
evidence_status: PARTIAL
not_run_count: 0
supersedes: none

## 第一轮（PASS 之后回看的 P0/P1）

| 项 | 级别 | 处置 | 状态 |
|---|---|---|---|
| 证据链可被「重锚」：把复核对像改成新摘要即可变绿 | P0 | 撤掉重锚，历史 PASS 只在归档里保留原结论；摘要改为索引 blob + LF 归一，跨机器可复现（后又在 2026-11-11 整体撤掉摘要机制） | 已修 |
| 停用员工后旧会话仍可用 | P1 | 停用即吊销 `sess` | 已修 |
| 超管占用工号 `005822`、依赖 `CADENCE_ADMIN_NO` | P1 | 改为独立 `admin` 账号 + `admin_auth` 表（不占工号、随机初始密码、首登强制改密） | 已修 |
| e2e 直接改真实库 | P1 | 改 `VACUUM INTO` 测试库副本，`--full` 自起实例、跑完删副本 | 已修 |
| 门禁自身缺反例（宣称会拦但没证明） | P2 | `gate-selftest.mjs` + `gate.py --selftest` 接进每次 `--fast`/`--hook` | 已修 |

## 第二轮（FAIL，五项与一项口径冲突）

| # | 第二轮指出的问题 | 本轮处置 | 状态 |
|---|---|---|---|
| 1 | `verify --hook` 可被手改 `verify-report.json` 绕过 | 不再有报告：`--hook` 当场跑与 `--full` 同一套检查（语法 + 版本 + CHANGELOG + 契约状态 + 门禁反例 + 工作区干净 + e2e），跑不过就不许提交。**被删的是凭证本身，不是又加了一层校验。** | 已修（换实现） |
| 2 | 三份历史 PASS 契约的锚点被当作当前树可复用的 PASS | 「复核对象」改绑**归档提交 `4762476`**，注明「仅对原树有效，未在现行树复核」；门禁只校验该提交在库里存在，不再把任何锚点当成当前树的 PASS；`pass-anchors.md` 删除 | 已修 |
| 3 | `-cv2` / `-cv3` 多余事件链，`contract_version` 不统一；可用新链绕过 | 三条链合并为一条（`contract_version: 3`），`-cv2` / `-cv3` 目录删除；`gate.py` 对「同一 task_id 两条链」判账本损坏；`bump-contract` 不再另开目录，改为同链重写 PLANNED（仅未开工时） | 已修 |
| 4 | 缺 `delivery.md` / `verdict.md`、状态未转、HEAD 的 `gate --ci` 红 | 本文件与 `delivery.md` 补齐；`task.md` 转 `READY_FOR_REVIEW`；整改提交带 `Task:` trailer，`gate --ci` 输出见 `delivery.md` §2.2 | 已修（结论仍待第三轮） |
| 5 | 文档口径漂移（AGENTS 摘要算法、review-checklist A4、契约模板、旧草稿、Spec C9 数量） | 逐处同步：AGENTS.md §4/§5 改为「当场跑、不留报告」并固定提交顺序；review-checklist A2/A4 改为归档提交号；契约模板标「已废弃」并改锚点写法；tooling 蓝图与 DEVELOPMENT.md 同步；Spec C9 改为 205 项 | 已修 |
| 附 | `--full` 通过提示「可以提交」，`gate --ci` 却红 | 规格上不是矛盾而是先后：`--full` 判「这棵树跑得通」，`--ci` 判「这条提交的流程走完没」。AGENTS.md §5 把顺序写死：`git add -A` → `verify --full` → `git commit`（pre-commit 当场重跑）→ `gate --ci`。`verify.mjs` 通过时的提示也按此改写 | 已修 |

## 仍未修 / 明确不做

- 历史三份 PASS 契约**没有重新复核**（用户明确「不重开历史复核」）：它们的结论只对归档提交有效。
- `--full` 与 `gate --ci` 的最终判定仍由人/独立复核给出；机器只证明「命令跑过、退出码为 0」。
- 明文 HTTP、cookie 无 `Secure` 属已接受风险 R1，本批不处理。
- 本文件不做 PASS 判定；`task done` 与 PASS 事件留给第三轮独立复核。

## 证据重建

- `node _dev/verify.mjs --full`：见 `delivery.md` §2.1（原始输出）。
- `python .agents/gates/gate.py --ci --repo .`：见 `delivery.md` §2.2（原始输出）。
- 事件链：`artifacts/runs/TASK-20261110-auth-export/events.jsonl`（单链，`contract_version: 3`）。
- 与 Worker 证据的差异：无（本轮所有数字与输出都来自当场命令回显）。
- NOT_RUN 清单：none（本轮未跳过任何检查项）。
