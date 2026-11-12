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

- `.agents/gates/gate.py` —— M1–M8 的唯一实现。`_dev/verify.mjs` 里的 `contracts()` 只校验 2026-11-04 前归档的旧契约（只读历史），不参与新契约判定。
- 在项目根运行：`python .agents/gates/gate.py --ci`（合并前/CI，按 `base...HEAD` 判）；`python .agents/gates/gate.py --fast --staged`（pre-commit，M1/M8/M3，只判索引区）。
- `--staged` 的边界：**未 add 的工作区改动不拦**（草稿不该挡人）；**已 add 的受保护路径没有匹配契约 → `BLOCKED`**（拦在即将进入历史的那一刻）。CI 的 `pull_request` 仍按 `base...HEAD` 判。
- `--selftest`：用临时仓库证明 M1/M8 真的会拦，已接进 `verify.mjs`，每次 `--fast`/`--hook` 都跑一遍。

## 账本长什么样

- 唯一事实源：`artifacts/runs/<task_id>/events.jsonl`。每行一个事件，字段 `seq / previous_hash / event_hash / state / role / metadata / evidence`，哈希链逐条可校验。
- 写入器：`.agents/scripts/agent_workflow.py`。开工前：

```
python .agents/scripts/agent_workflow.py init artifacts/runs/<task_id> \
  --task-id <task_id> --contract-version 1 --base-revision <sha> \
  --contract artifacts/runs/<task_id>/task.md --evidence <evidence-file>
```

- 之后用 `transition` 追加 `PLANNED -> IN_PROGRESS -> READY_FOR_REVIEW -> PASS`；**不允许手改 JSONL**。


## 增量安装（`install`）

```
python <skill>/scripts/scaffold_project.py <project_root> --install
```

- 只补缺失文件，从不覆盖；已存在且内容相同记为 `unchanged`。
- 冲突（同名但内容不同、`pre-commit` 已有同名不同 entry）进 `conflicts` 清单，原文件不动。
- 退出码：`0` = 全部就绪（含原本已存在）；`2` = 有冲突需人工裁决。
- `.pre-commit-config.yaml` 已存在、且最后一个顶层键仍是 `repos:` 时，追加 `ai-native-gate-fast` 钩子；否则报 `manual_merge_required`。
