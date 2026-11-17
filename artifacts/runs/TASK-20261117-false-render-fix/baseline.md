# 基线证据 — TASK-20261117-false-render-fix

## 1. 工作区与构建（命令原始输出）

```
$ git log --oneline -2
885cd46 docs(更新): 0.9.7 说明补全——纳入「更新弹窗改为登录成功后弹出」
4045bf6 feat(专项): 阶段派发落地成子专项，支持接收、三层嵌套与父子导出

$ git status --short
 M public/app.js
?? artifacts/runs/TASK-20261117-false-render-fix/

$ curl http://127.0.0.1:8788/api/version
{"ok":true,"semver":"0.11.0","version":"0.11.0+91.4045bf6", ...}
```

结论：8788 进程启动于 `4045bf6`，之后另一路提交了仅含文档的 `885cd46`，所以构建串短哈希落后 HEAD 一个提交；代码文件未变。本轮结束会重启，使构建串与 HEAD 一致并复验。

## 2. 用户截图对应的数据（直查 data/workbench.db）

```
{"id":"1012_t4","type":"special","owner":"1012","assignee":"1012","status":"doing","title":"部门数据看板建设"}
    {"id":"s3","pid":null,"name":"看板搭建与试运行","done":false}
    {"id":"s3a","pid":"s3","name":"前端页面搭建","who":"1005","whoAt":"2026-11-10T14:20:11.009Z","joinedAt":"2026-11-10T14:20:11.009Z","done":false}
    {"id":"s3b","pid":"s3","name":"指标口径复核","who":"1004","whoAt":"2026-11-10T14:20:11.009Z","joinedAt":null,"done":false}
{"id":"1012_t5","type":"special","owner":"1012","assignee":"1012","status":"todo","title":"部门制度修订（考核细则）"}
    {"id":"s1","pid":null,"name":"问题清单收集","done":false}
    {"id":"s2","pid":null,"name":"细则起草","done":false}
    {"id":"s3","pid":null,"name":"会签与发布","done":false}
```

- `1012_t5` 只有一级阶段 → 详情里没有任何「谁做」入口，只能先点「+ 子任务」。
- `1012_t4` 有二级阶段 `s3a/s3b`，且都带旧链路的 `whoAt` → 详情里二级行显示「谁做」下拉。

## 3. 界面证据（1600×1000）

- `walkthrough/step1-detail-no-substage.png`：打开 `部门制度修订（考核细则）` 详情，三个一级阶段行只有 改 / + 子任务 / 删。
- `walkthrough/step2-click-add-sub.png`：点第 1 段的「+ 子任务」后，行下方展开表单，含「谁做」下拉（默认「承接人自己做」）+ 加/取消。
- `walkthrough/step1b-detail-with-substage.png`：打开 `部门数据看板建设` 详情，二级行 3.1/3.2 右侧有「谁做」下拉（赵敏 / 王浩）。

## 4. 代码定位

- `public/app.js:1359`（修复前）：`${r.sub && (r.s.child ? ... : ...)}`；一级阶段 `r.sub === false`，布尔短路值被模板字符串插成 `false`。
- `public/app.js:2128`：「+ 子任务」按钮；`public/app.js:3243-3247`：二级子任务表单里的「谁做」。
- `public/app.js:1937-1940`：详情页「派发」按钮所在提示条，只在存在 `pid && who && !whoAt` 的段时显示。
