# `.agents/` 运行入口

这一页只讲"怎么跑"。规则在项目根 `AGENTS.md`，判定细节见 skill 的 `GATES.md`。

## 这目录里装什么

| 路径 | 是什么 |
|---|---|
| `SPEC.md` | 需求语义、能力边界、公开契约不变量（M4 读它的 `version_authority`） |
| `issues.md` | 问题台账，每条带 `fail_source` |
| `review-checklist.md` | G2 复核清单 |
| `templates/` | 契约三件套模板（task / delivery / verdict） |
| `gates/` | 契约门禁 `gate.py` |
| `scripts/` | 账本写入器 `agent_workflow.py` |
| `schemas/` | 账本与记录的 JSON Schema |
| `practice/` | 采纳记录、实践台账、skill 反馈 |
| `archive/` | 退役档案（旧手工契约、一次性计划），只读 |

## 门禁在哪

- `.agents/gates/gate.py` —— M1–M8 唯一实现，没有第二套逻辑。
- 在项目根运行：`python .agents/gates/gate.py --ci`（合并前/CI，按 `base...HEAD` 判）；`python .agents/gates/gate.py --fast --staged`（pre-commit，M1/M8/M3，只判索引区）。
- `--staged` 的边界：**未 add 的工作区改动不拦**（草稿不该挡人）；**已 add 的受保护路径没有匹配契约 → `BLOCKED`**（拦在即将进入历史的那一刻）。CI 的 `pull_request` 仍按 `base...HEAD` 判。
- 受保护面写在同一目录的 `protected.json`（本项目真实代码路径），**不是**脚手架默认的 `app/`；模块归属由蓝图 `paths:` 声明，不从文件名猜。
- M8 受理闸：受保护改动对应的 `task.md` 必须有 `requirement_quote` / `user_problem` / `out_of_scope` / `acceptance_command` / `stop_conditions` 五个字段，缺项或占位符即 `BLOCKED`（只判 `rule_epoch>=4` 的新 run，旧证据不追溯）。
- `--selftest`：用临时仓库证明 M1/M8 真的会拦，覆盖正例、无契约、字段缺失、占位符（含语气词/标点/括号补注的等价类）、模块不拥有该文件、旧 epoch 兼容；当前 26 条用例，已接进 `verify.mjs`。
- `--scope` 默认 `project`：M2/M6 没有事件流时记 `NOT_RUN`，整体 `no_evidence`，退出 1。**项目仓库不得使用 `--scope suite`。**
- M4 需要版本权威：在 `.agents/SPEC.md` 里写 `version_authority: version.js`。未声明时 M4 记 `NOT_RUN`（"项目未声明版本权威"），不会假装 PASS；套件仓库则要求版本声明恰好 1 处。
- 提交点与合并点不同：pre-commit（`--staged`）在**尚未建立任务账本**时打印醒目提示但**不拦**（拦的是"没有契约的受保护改动"）；CI（`--ci`）对同样的 `no_evidence` **退出 1**（拦的是"没有证据的合并"）。

## 账本长什么样

- 唯一事实源：`artifacts/runs/<task_id>/events.jsonl`。每行一个事件，字段 `seq / previous_hash / event_hash / state / role / metadata / evidence`，哈希链逐条可校验。
- 写入器：`.agents/scripts/agent_workflow.py`。开工前：

```
python .agents/scripts/agent_workflow.py init artifacts/runs/<task_id> \
  --task-id <task_id> --contract-version 1 --base-revision <sha> \
  --contract artifacts/runs/<task_id>/task.md --evidence <evidence-file>
```

- 之后用 `transition` 追加 `PLANNED -> IN_PROGRESS -> READY_FOR_REVIEW -> PASS`；**不允许手改 JSONL**。
- 门禁只读这份事件流，不生成任何派生账本。

## 什么时候会 block

| 情况 | 结果 |
|---|---|
| 改动触及受保护路径（`protected.json` 声明的 `server.js` `public/` `_dev/` `specs/` `data/` `AGENTS.md` 等），但没有 `Task:` trailer 或没有 `PLANNED` 事件 | M1 `BLOCKED` |
| 已 `git add` 的受保护路径没有匹配的 `PLANNED` 契约（pre-commit `--staged`） | M1 `BLOCKED` |
| 契约声明的模块，其蓝图 `paths:` 不拥有改动的文件（含“拿文件名当模块名”的旧写法） | M1 `BLOCKED` |
| 受理五字段缺一项，或值仍是 `<待填>` / `TBD` / `-` | M8 `BLOCKED` |
| `task.md` 在 `PLANNED` 之后被改写（契约摘要不符） | M1 `BLOCKED` |
| 有 `PASS` 事件但缺 `verdict.md` / `delivery.md`，或字段、摘要对不上 | M2 `BLOCKED` |
| `verdict` 说 FAIL 而事件流说 PASS；`evidence_status=NOT_RUN`；`not_run_count>0`；`max_severity` 为 P0/P1 | M2 `BLOCKED` |
| 候选快照缺失，或快照字节与记录摘要不符 | M6 `BLOCKED` |
| 事件流 JSON 损坏、哈希链断裂 | `ledger error`，相关检查 `BLOCKED` |
| 只有 `NOT_RUN`、没有 `BLOCKED` | 整体 `no_evidence`：CI 退出 1；pre-commit `--staged` 退出 0 并打印"尚未建立任务账本"提示 |

## 增量安装（`install`）

```
python <skill>/scripts/scaffold_project.py <project_root> --install
```

- 只补缺失文件，从不覆盖；已存在且内容相同记为 `unchanged`。
- 冲突（同名但内容不同、`pre-commit` 已有同名不同 entry）进 `conflicts` 清单，原文件不动。
- 退出码：`0` = 全部就绪（含原本已存在）；`2` = 有冲突需人工裁决。
- `.pre-commit-config.yaml` 已存在、且最后一个顶层键仍是 `repos:` 时，追加 `ai-native-gate-fast` 钩子；否则报 `manual_merge_required`。
