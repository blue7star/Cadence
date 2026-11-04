<!-- 开工：`agent_workflow.py task start --task-id <id> --contract <本文件> --gate-level <G> --evidence <日志路径>`。`--evidence` 必填：先落盘基线证据，再推进状态。 -->

# Task Contract — <task_id>

> 由 Planner 写；`gate.py` 的 M1/M3 读本文件。字段名改动需同步 `schemas/task.json` 与 `gates/gate.py`。

## 元信息

task_id: <TASK-YYYYMMDD-slug>
contract_version: 1
base_revision: <commit>
gate_level: G1 | G2 | G3
status: PLANNED
owner: Planner
modules: <mod-a, mod-b>          # M3 按此追加蓝图变更历史；无模块写 none
sibling_tasks: none              # 并行分派时列出同批其他 task_id；单任务写 none
blueprint_impact: pending        # none 时 M3 放行，但该声明受 M2 核对
parallel_group: none             # 可选；并行组名

## 目标与范围

- 业务目标与用户可见的成功：
- 范围内（in scope）：
- 范围外（out_of_scope）：**必须写**——没有范围外声明的契约不得进入 G2
- 已批准的 L0-L2a 决策：
- 受影响的事实归属者与契约：

## 风险与权限

- 风险理由（为什么不是 G0）：
- Human 已决策事项：
- Worker 不得自行决定的事项：
- 允许的工作区与破坏性操作：
- 停止与上报条件：

## 验收证据

- 确定性检查（命令 + 期望退出码）：
- 集成与反向路径：
- 文档同步（蓝图 / specs）：
- 安全、数据、迁移与回滚证据（G3 必填）：
