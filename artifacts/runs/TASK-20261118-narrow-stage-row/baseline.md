# Baseline — 窄屏阶段行

采集于 `c4c090a`（0.15.0+100.c4c090a）。

## 改前样式（public/index.html）

- `.mrow .row2{display:flex;gap:6px;align-items:center}`：单行、禁止换行。
- `.mrow .row2 input{flex:1;min-width:0}`：两个日期框平分剩余宽度。
- `.mrow .row2 select.swho{flex:0 0 118px}`：固定宽；默认项 `承接人自己做（张三）` 文字超出被截断。
- `.mrow .row2 .addsub` / `.del`：`flex:0 0 auto`，无换行时被推出容器 → 弹窗横向滚动。
- 详情页「+ 添加阶段」：`<div class="row">` 无 flex 规则，靠内联 `flex:1` 失效，换行不可控。
- `.subadd .row{display:flex}`：同样不换行，`.subadd select.swho{flex:0 0 116px}`。
- `.sedit .row{display:flex}`：改阶段表单同样不换行。

## 四个入口

1. 新建专项任务弹窗（`#modal.wide`，`stageRowHTML` → `.mrow .row2`）
2. 发布任务弹窗（同一模板）
3. 详情页「+ 添加阶段」（`#sName/#sStart/#sEnd/#sWho`）
4. 阶段行「+ 子任务」（`.subadd .row`）

## 其他

- 默认项文案来自 `whoOptionsHTML()`：`承接人自己做（${nameOf(ownNo)}）`。
- `change` 事件里还有一段专门把该文案跟着承接人改写的代码，缩短文案后可删除。
- 历史「右侧出现 false」：本次按入口逐个检查 `innerText` 是否出现字面量 `false`，e2e 固化为断言。
