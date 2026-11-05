# 模块蓝图索引

> 模块边界、不变量、依赖方向的**权威**在这批蓝图文件里，别处不再维护第二份；旧 `docs/modules.md` 已删除，历史见 git。
> 实现细节看代码，业务口径看 `README.md`，工程细节看 `DEVELOPMENT.md`。

## 依赖方向（只能朝下，不能回头）

```
public/index.html ──样式────┐
public/app.js ──────────────┼── HTTP ──→ server.js ──→ version.js
public/changelog.js ────────┘              │
                                           └──→ data/workbench.db（node:sqlite）
```

- 前端不 require 任何服务端文件，只走 `/api/*`。
- `version.js` 是版本唯一源。
- 服务端不读前端代码，只按文件名发静态文件。

## 蓝图清单

| 模块 | 文件 | 一句话职责 |
|---|---|---|
| MOD-version | `version.md` | 版本号与更新内容唯一归属 |
| MOD-server-data | `server-data.md` | 建表 + 常规实例引擎 |
| MOD-server-api | `server-api.md` | 同步、动作接口判权、可见性 |
| MOD-app-ui | `app-ui.md` | 状态层 + 阶段 UI + 日历 |
| MOD-tooling | `tooling.md` | 花名册导入 + 自检门禁 |

## 改哪个模块，顺手要看哪里

| 改动 | 一并检查 |
|---|---|
| 加接口字段 | `stateFor()`、`applySync()`、`public/app.js` 的 `S` 结构、e2e 里读该字段的断言 |
| 改日期算法 | `ruleSteps`、`stepPlanDate`、`calCells`、`chipLate`，以及 `_dev` 里对应的用例 |
| 改视觉 | `index.html` 的 `.chip.cal` 与图例同时改；跑 e2e 的三条断言 |
| 改可见性 | `stateFor()`、`subsOf()`、详情页只读分支、切换身份用例 |
