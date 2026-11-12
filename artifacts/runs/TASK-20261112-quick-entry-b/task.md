# Task Contract — TASK-20261112-quick-entry-b

> 今日待办顶部快速录入条改「一句话」形态：日期说人话、时间按需出现，只动这一条。

## 元信息

task_id: TASK-20261112-quick-entry-b
contract_version: 1
base_revision: c34934e
gate_level: G1
status: PLANNED
owner: Planner
modules: app-ui, tooling, version
sibling_tasks: none
blueprint_impact: required
parallel_group: none

## 受理

requirement_quote: 用户确认按 B 做：①日期 chip 显示 今天/明天/后天/11月13日，点击仍是一次打开原生选择器；`#qDate` 的 id 保留，现有 e2e 赋值方式不要改坏。②时间默认收成 32×32 图标按钮，点开原地变成时间框（不弹层、不换行）；填了显示 09:30，清空回到图标。③控件统一 height:32px、padding:0 10px、font-size:13px、border:1px、radius:8px、align-items:center；根因是内边距三套，连这个一起修。④窄屏低于 820px 时间自动收成图标，单行不换行；实在装不下时换行后按钮必须右对齐。⑤建的非今天时按钮左侧加 11px 灰字「将建到 11月13日」，不增高，toast 保留。⑥日期改成记住上一次选择，连建几条明天的活不用重选；刷新后回到今天。如果与现有断言冲突要明说，不许偷偷放宽。
user_problem: 上一版在录入条里并排放了标题/日期/时间/按钮四个原生控件：高度 30.0/30.1/32.7/30.4，时间框比标题高 2.7px、顶边高 1.4px；内边距三套（7/10、6/8、6/12）；日期框 132px 与时间框 80.7px 比例失衡；两个原生控件图标与文字基线割裂；整条更像工具栏而不是「一句话」；762px 视口下换行后按钮孤零零落在第二行最左。
out_of_scope: 不改服务端、表结构、导出/导入；不改临时任务单日语义；不改日历底部入口与其它新建入口；不引入弹层或第三方组件；不改列表、右栏与其它页面。
acceptance_command: node _dev/verify.mjs --full（期望退出码 0）
stop_conditions: showPicker 在目标浏览器不可用且影响点击区；需要服务端配合；需要放宽既有断言才能通过；工作区出现其它会话的未提交文件。

## 目标与范围

- 业务目标与用户可见的成功：
  - 默认这条只有「标题 + 今天 + 时钟图标 + 按钮」，日期读起来是「今天/明天/后天/11月13日」；
  - 点日期 chip 一次打开原生选择器（`#qDate` 保留）；时间点开原地展开、填完显示 09:30；
  - 非今天时按钮左侧出现「将建到 X」，行高不变；
  - 记住本次会话的日期，刷新回今天；
  - 1600 视口下四个元素同高 32px、同基线；760–820px 仍单行。
- 范围内：public/app.js（viewToday 表单、syncQuickDate/syncQuickTime、点击与 change/focusout 处理、提交记忆）、public/index.html（录入条样式与两条媒体查询）、_dev/e2e.mjs（断言改口径 + 新增 chip/提示/时间/刷新断言）、specs/modules/*.md、README、version.js/CHANGELOG。
- 范围外：见 `out_of_scope`。
- 已批准的决策：日期 chip 点击仍一次开原生选择器；时间图标化；记住日期、刷新回今天；窄屏提示条在 840px 以下隐藏（chip 本身仍显示日期，信息不丢）。

## 风险与权限

- 风险理由（为什么 G1）：改的是最高频创建入口与默认日期语义，错误会把任务静默建到错误日期。
- Human 已决策事项：B 方案六条口径。
- Worker 不得自行决定的事项：临时任务跨多天、类型定义、阶段规则、导出格式、其它新建入口。
- 允许的工作区与破坏性操作：仅上节「范围内」文件 + `artifacts/runs/TASK-20261112-quick-entry-b/`。不得改 server.js、data/、.agents/gates/。
- 停止与上报条件：见 `stop_conditions`。

## 验收证据

- 确定性检查：`node _dev/verify.mjs --full` 退出码 0；`gate --ci` 原始输出随交付。
- 集成与反向路径：e2e 断言「选明天 → 落库明天、chip 显示明天、日期被记住」「非今天显示将建到哪天」「时间填 09:30 后行高仍 ≤33」「刷新后回到今天」。
- 文档同步：app-ui 公开行为 + 三份 blueprint 变更历史；README 临时任务一行。
- 视觉证据：1600×1000 改前（沿用上一版截图）/改后默认/改后选中明天，落 `walkthrough/`，逐条列问题。
- 安全、数据、迁移与回滚证据：无表结构、无数据迁移；回滚为还原 app.js/index.html 两个文件。
