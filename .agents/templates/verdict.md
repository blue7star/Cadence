<!-- `task submit --evidence <路径>` 必填；本文件由 Reviewer 人写，工具只校验与封存，不代写。 -->

# Verdict — <task_id>

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: <task_id>
contract_version: 1
candidate_revision: 1
candidate_digest: <sha256>
base_revision: <commit>
reviewer: Reviewer
reviewer_context: <new-session-id>      # 必须 ≠ worker_context
worker_context: <session-id>
attempt: 1
verdict: PASS | FAIL_IMPLEMENTATION | FAIL_DESIGN | NEEDS_BUSINESS_DECISION | BLOCKED
max_severity: NONE | P0 | P1 | P2 | P3
evidence_status: COMPLETE | PARTIAL | NOT_RUN | BLOCKED
not_run_count: 0
supersedes: none

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明（是否新上下文、是否读过实现过程的私有信息）：
- 本次读取的项目权威（文件 + 章节）：
- 已核对的 Task Contract 与 delivery 摘要：

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
|  |  |  |  |  |

## 证据重建与残余风险

- 重跑的命令、退出码与原始证据路径：
- 与 Worker 证据的差异：
- NOT_RUN 清单：none
- 残余风险：
- 判定理由：

## 业务语义（仅 G3）

- 这个风险愿不愿担：
- 用户可见影响：
- 若出错如何回退：
