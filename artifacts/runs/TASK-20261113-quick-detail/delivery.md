# Delivery — TASK-20261113-quick-detail

## 改了什么

- `public/app.js`
  - 录入条按钮由 `type=submit` 改为 `type=button` + `data-act="qdetail"`，文案「＋ 临时任务…」，tooltip 说明「打开完整表单…；回车则按默认直接建」。
  - 新增 `qdetail` 分支：读取录入条标题/日期/时间，调用已有的 `openNewTask('temp', {title, date, end, time})`，不创建任务。
  - 表单内不再依赖隐式提交：按钮改 `type=button` 后，实测 CDP 发真实 Enter 不会触发提交，因此在 `keydown` 里显式拦 Enter（标题/日期/时间三个控件）并派发 submit。
  - `taskModalBody()` 支持 `preset.end` 与 `preset.time`，预填结束日与时间点；未传时行为不变。
  - placeholder 改为「回车直接建，按钮填细节…」。
- `_dev/e2e.mjs`
  - 快速建任务改用 CDP 发真实 Enter（不再手动 dispatch submit），并断言默认字段：`temp`、时间空、达成标准空、分类「其他」、优先级 null。
  - 新增：点按钮不建任务（本地与服务端任务数都不变）、弹窗打开且标题/起止/时间已预填；取消后录入条标题仍在；再次打开仍预填；弹窗提交后落库的 `time/std/imp/urg/cat1/start/end/type` 与填写一致。
- `specs/modules/app-ui.md`：公开行为补两个出口的分工；变更历史加一行。
- `specs/modules/tooling.md` / `version.md`：变更历史各一行。
- `version.js`：0.9.4 → 0.9.5；CHANGELOG 由 `node version.js --write` 生成。

## 没做什么

- 没改服务端、表结构、导出/导入；没动其它新建入口；没改临时任务单日语义；没有另造表单。

## 一个需要知道的实现细节

按钮不再是 submit 后，回车不再靠浏览器隐式提交：`keydown` 里显式识别 Enter 并派发 submit。第一次跑 e2e 时真实 Enter 没建出任务，就是隐式提交没触发；改成显式后 226 项全绿。若以后有人删掉这段 keydown，e2e 会直接红。

## 验证

- `node _dev/verify.mjs --full`：见本轮汇报。
- `gate --ci --repo .`：见本轮汇报。

## 视觉证据

- `walkthrough/01-before-bar-1600.png`、`02-after-bar-1600.png`、`03-after-modal-prefill-1600.png`
- 逐条问题与实测：`walkthrough/self-review.md`

## 未自签

未写 `verdict.md`、未标记 PASS；独立复核留给 Reviewer。
