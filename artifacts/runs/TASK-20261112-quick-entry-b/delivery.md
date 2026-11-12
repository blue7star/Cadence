# Delivery — TASK-20261112-quick-entry-b

## 改了什么

- `public/app.js`
  - `viewToday()` 的录入条改为：标题输入 + 日期 chip（今天/明天/后天/日期）+ 时间图标/时间值 + 「将建到 X」提示 + 按钮。
  - 新增 `quickWhenLabel()`（近三天说人话，更远报日期）、`syncQuickDate()`（同步 chip 文案、future 态与提示条）、`syncQuickTime()`（图标↔输入框切换、回显 09:30）。
  - 新增点击动作 `qdate-open`（`showPicker()`，不支持则聚焦）与 `qtime-open`（原地展开时间输入并开选择器）；新增 `change`/`focusout` 同步。
  - 提交时记住 `quickDate`；`viewToday()` 在跨零点后把过期日期清回今天；提交后表单按记住的日期重渲染。
- `public/index.html`：录入条样式统一 `height:32px / padding:0 10px / font-size:13px / border:1px / radius:8px / align-items:center`；日期 chip、时间按钮、提示条样式；`max-width:840px` 隐藏提示条，`max-width:720px` 换行时按钮右对齐。
- `_dev/e2e.mjs`
  - 原断言「日期框回到默认今天」**按新口径改为**「记住上次选择并显示明天」——这是与旧断言的直接冲突点，已在此显式记录，不是为了让测试变绿而放宽。
  - 新增：非今天显示「将建到 X」；时间填 09:30 后行高仍 ≤33；`goto(BASE)` 刷新后日期回到今天。
- `specs/modules/app-ui.md`：公开行为改写；变更历史加一行。
- `specs/modules/tooling.md` / `version.md`：变更历史各一行。
- `README.md`：临时任务一行补充日期可读词、时间按需展开、记住本次选择。
- `version.js`：0.9.3 → 0.9.4，新增 CHANGELOG 条目；`CHANGELOG.md` 由 `node version.js --write` 生成。

## 没做什么

- 没改服务端、表结构、导出/导入；没改临时任务单日语义；没动日历底部入口与其它新建入口。
- 没有引入弹层/第三方组件。

## 与旧断言的冲突（按要求明说）

旧 e2e 断言「提交后日期框回到默认今天」与新需求「记住上一次选择」直接矛盾。已改为断言 `#qDate` 保留所选日期、chip 显示「明天」，并新增刷新后回今天。若不同意这个口径，请回退该需求而不是保留旧断言。

## 验证

- `node _dev/verify.mjs --full`：见本轮汇报（目标 13/13）。
- `gate --ci --repo .`：见本轮汇报。

## 视觉证据

- `walkthrough/01-before-today-1600.png`、`02-before-tomorrow-1600.png`（改前）
- `walkthrough/03-after-today-1600.png`、`04-after-tomorrow-1600.png`、`05-after-narrow-762.png`（改后，v0.9.4）
- 逐条问题与实测值：`walkthrough/self-review.md`

## 未自签

未写 `verdict.md`、未标记 PASS；独立复核留给 Reviewer。
