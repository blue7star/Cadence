# Task Contract — TASK-20261116-year-routine

## 元信息

task_id: TASK-20261116-year-routine
contract_version: 1
base_revision: f7a1b46
gate_level: G2
status: PLANNED
owner: Planner
modules: server-api, server-data, app-ui, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理（M8）

requirement_quote: 「工作台加一个年常规」
user_problem: 常规工作只有日/周/月三档。行政的年度体检、年度预算、年度评优这类「每年固定某月某日」的工作没有地方安放，只能每年临时手建或拿月常规凑，容易漏、也看不出是年度节奏。
out_of_scope: 不做季度/半年/农历；不改节假日表、不改跨年顺延算法；不动日/周/月的生成窗口与行为；不做导入/导出格式变更；不改拖拽校验；不新建页面，只在既有常规工作页加一个页签。
acceptance_command: node _dev/verify.mjs --full（期望退出码 0，13 项全绿）
stop_conditions: ① 工作区出现非本任务的改动且未清场就提交；② 年度实例在 ±(40/366) 天窗口内仍不可见；③ 必须改变日/周/月行为才能让年常规跑通；④ 需要改节假日表或扩表才能正确顺延。

## 目标与范围

- 业务目标与用户可见的成功：在「常规工作」里能建「年常规」，指定「几月几日」（可多个节点），当年与次年的实例能在规则卡与日历里看到；改规则后实例仍在并按新日期重排。
- 范围内：
  - `rule.cycle='year'`；节点字段 `monthNo`（1-12）+ `day`（1-31）+ `time` + `policy`。
  - 年规则生成窗口：`today-40d ~ today+366d`，只对 `cycle='year'` 生效；其它周期保持 `+80d`。
  - `regenRule` 删除范围改为「本次生成窗口内」，修掉窗口外实例被删且不重建。
  - `upsertRule` 周期白名单 + 年节点字段校验，非法值回可读错误。
  - 前端：页签「年常规」、周期下拉、节点行（月/日）、`cycleCN`/`cycleLabel`/`nodeDayText`、规则卡与跨年文案。
- 范围外：见元信息 `out_of_scope`。
- 已批准的 L0-L2a 决策：
  - 用户拍板方案 B：年规则专用窗口「今年 + 明年」（+366 天），日/周/月一行不许变。
  - 节假日表只有当年、跨年顺延可能只按周末算：只写进交付说明，不改算法、不扩表。
- 受影响的事实归属者与契约：`specs/modules/server-api.md`、`server-data.md`、`app-ui.md`、`tooling.md`、`version.md`；`DEVELOPMENT.md` 常规规则一节。

## 风险与权限

- 风险理由（为什么不是 G0）：改日期算法（周期切分与节点落点）与生成窗口，属 G2。
- Human 已决策事项：年窗口 +366 天且只影响 `cycle='year'`；跨年顺延限制只文档化。
- Worker 不得自行决定的事项：扩节假日表、改日/周/月窗口、增加季度/半年、改导入导出。
- 允许的工作区与破坏性操作：只改本任务相关文件；不触碰他人未提交文件；不 `--no-verify`。
- 停止与上报条件：见元信息 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出 0；`python .agents/gates/gate.py --ci --repo .` 通过。
- 集成与反向路径（e2e）：
  - 年常规：页签存在；建「每年 8 月 31 日」→ 实例 id `ri_<rule>_<YYYY>`、`plan_date` 精确到 `2027-08-31`；日历 2027-08 可见；连续两次 state 条数不变（maintain 幂等）；改规则到 8 月 30 日后实例仍在且日期更新。
  - 回归：日/周/月各建一条，实例 key 形态分别为 `YYYY-MM-DD` / `YYYY-MM-DD` / `YYYY-MM`，各 1 条。
  - 反向：`cycle='quarter'` 经 `/api/sync` 被拒并回可读原因；年节点缺 `monthNo` 被拒。
- 文档同步：五份蓝图 + `DEVELOPMENT.md` + `version.md` 变更历史。
- 安全、数据、迁移与回滚证据：`rule.cycle` 是 TEXT、无约束，旧数据零迁移；回滚只需回退代码，年规则数据仍可读（前端按未知周期显示为月，不影响日/周/月）。
