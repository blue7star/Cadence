# 交付说明 — 窄屏阶段行布局（v0.15.1）

task_id: TASK-20261118-narrow-stage-row
contract: v1

## 改了什么

- `public/app.js` 阶段行模板：`.row2` 拆成 `.r2a`（开始日 / 结束日）与 `.r2b`（谁做 / + 子任务 / 删除）两组；`+ 子任务` 仍在 `.r2b` 内。
- `public/index.html`：
  - `.mrow .row2`、`.subadd .row`、`.sedit .row` 全部 `flex-wrap:wrap`；日期组 `flex:1 1 200px`，操作组 `margin-left:auto` 并在自身内部也允许换行。
  - 所有「谁做」下拉（弹窗/子任务/改表单/再加一段）限宽 `132px`，`overflow:hidden;text-overflow:ellipsis;white-space:nowrap`；原生展开的选项不受限。
  - 详情页「+ 添加阶段」改用 `.addstage-row`（之前依赖内联 `flex:1`，没有明确的折行规则）。
- `whoOptionsHTML()` 默认项从「承接人自己做（张三）」缩短为「承接人自己做」；同时删掉原先跟着承接人改文案的 `change` 监听（已无必要）。
- 自检：四个入口的 DOM `innerText` 不出现字面量 `false`；弹窗/页面 `scrollWidth <= clientWidth`；所有操作控件右边界不超出弹窗/视口。

## 验证

- `node _dev/verify.mjs --full`：13/13 全绿，e2e 297 项（+3）。
- 新增 e2e：
  - 发布弹窗 1024 / 1280：无页面横向滚动、弹窗无横向滚动、`.r2b` 内每个控件都在可视区、下拉 `max-width:132px`、无 `false` 字面量；
  - 详情页「+ 添加阶段」1024：控件都在卡片内、无横向滚动、无 `false`；
  - 「+ 子任务」1024：日期组与操作组都在视口内，同时保留「选人即派」断言。
- 截图：`walkthrough/` 下 12 张（4 入口 × 1024/1280/1600）+ 1024 阶段行放大图。1024 下四个入口实测 `scrollWidth<=clientWidth`、`inside=true`。

## 边界

- 只改布局与默认项文案，不改派发、状态机、接口与导出。
- 1200px 以下若弹窗宽度继续收窄，操作组会整体折到下一行，不会压缩日期框或推出按钮。
