# 交付说明 — 阶段派发 → 子专项嵌套（v0.11.0）

task_id: TASK-20261116-stage-dispatch-nesting
contract: v2（`task.md`，变更见 `amendment-v2.md`）

## 做了什么

把「派发」从「只写 `whoAt` + 等对方加入待办」改成**落地成一条子专项**：

1. **派发**（`POST /api/task/dispatch`）：每个已指定责任人的子任务段建一条 `type=assign`、`intake_status=pending`、带 `parent_task_id/parent_stage_id` 的子任务，同时清空父阶段的 `who/whoAt`。对方接收后（`/api/task/accept`）它变成 `type=special` 的独立专项，能自己拆阶段、排期、再往下派一层。
2. **三层封顶**：新任务深度 = 父深度 + 1，> 3 在服务端整次拒绝；界面在第三级禁用「派发」并写明原因。
3. **完成态单一权威**：子专项 `status` 是唯一真相。父阶段不落 `done`（`applyChildOwnership` 清空、`stagesWithChild` 读侧派生），父任务 `status` 由 `syncParentFromChild` 单向上汇总；父方勾选被拒，文案沿用「这一段由别人负责，只有他能勾完成」。
4. **可见集去重**：带父引用的行只从「我是负责人 / 我承接」进入，publisher、下属专项、`source_id`、阶段责任人四条来源一律排除；派发人只在父阶段上看到 `child` 摘要（状态/进度），看不到子专项的 `stages`。
5. **撤回 / 改派（仅接收前）**：`undispatch` 删 pending 子专项并把 `who` 还原到父阶段；`dispatch{stageId, who}` 只换 pending 的承接人。已接收的接口明确拒绝。
6. **删除只脱钩**：删父任务或父任务里的某一段，清空子专项的父引用并保留它；已接收的写 `kind=detached` 提醒。
7. **进度加权**：派出去的段算 1 个叶子，按子专项进度折算（`taskProgressOf` / `taskProg` 同口径）。
8. **导出 27 列**：末尾追加「父任务编号」「父任务阶段编号」；被派发阶段的负责人/完成/完成日读子专项。

## 数据模型

```sql
ALTER TABLE task ADD COLUMN parent_task_id TEXT;
ALTER TABLE task ADD COLUMN parent_stage_id TEXT;
CREATE UNIQUE INDEX uq_task_parent_stage ON task(parent_task_id, parent_stage_id)
  WHERE parent_task_id IS NOT NULL AND parent_stage_id IS NOT NULL;
```

- 老库不重建：两列可空，老行全空；partial unique index 不检验 NULL 行。
- 唯一索引左前缀即 `parent_task_id` 的查询索引，未另建冗余单列索引（已在 `server-data.md` 写明）。
- `stage_ref` 老镜像 2 行原样保留、读写语义不变；新流程不再写它。
- 回滚：删代码即可，两列留在库里不影响旧代码。

## 同步的文档

`specs/modules/server-data.md`（新列、INV-4、索引口径）、`server-api.md`（派发/撤回/可见性/透视/深度）、`app-ui.md`（阶段行、第三级禁用、进度加权）、`version.md`（0.11.0）、`specs/features/auth-and-transfer.md`（27 列 + 列名冲突说明）、`DEVELOPMENT.md`（表结构、七个动作接口、阶段派发条目）。

## 界面

1600 视口改前/改后截图与逐条自审：`walkthrough/`（`00` 改前、`01` 待接收、`02` 第三级禁用）。

## 已知限制（本轮明确不做）

- 已接收子专项的换人 / 撤回：接口拒绝，界面只显示「由 X 负责」。
- 导入未实现；只冻结了导出 27 列的格式。
- 父阶段与子专项的日期不自动同步：父阶段是父任务的排期，子专项自己的计划归负责人。
- 派发后父阶段不再支持「换人再派」：待接收可撤回/改派，已接收不动。

## 验证

- `node _dev/verify.mjs --full`：见提交前的原始输出（附在交付报告里）。
- 旧 e2e「派发 → 加入待办 → 副本只读 → 完成回写」整组改写为新链路（9.9 / 9.11），未跳过、未放宽期望；新增 9.12 三层封顶与导出父子列断言。
- 老镜像兼容：`stage_ref` 两行仍按旧路径可读、可勾完成回写（代码未动，e2e 的旧断言仍覆盖）。
