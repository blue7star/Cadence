# 交付说明 — TASK-20261116-year-routine（年常规）

## 状态

实现、自测、版本与文档均已完成；按用户拍板「一次性提交、清空工作区」合并提交，提交信息分两段说明归属（年常规 + 工作区既有 0.9.7 改动）。

## 归属说明（提交内含两批内容）

- 本任务：年常规（`server.js`、`public/app.js` 年常规相关、`DEVELOPMENT.md`、四份蓝图、`_dev/e2e.mjs`、`_dev/shot-once.mjs`、`version.js` 的 0.10.0 条目）。
- 工作区既有未提交改动：`0.9.7 更新记录转圈修复`（`public/changelog.js`、`public/app.js` 的 3 处、`version.js` 的 0.9.7 条目、`CHANGELOG.md` 的 0.9.7 段）。非本轮作者、本轮未改其逻辑；`node version.js --write` 重新生成 CHANGELOG 时原样保留了 0.9.7 段（见 `CHANGELOG.md:27`）。

## 数据库隔离（本轮对真实库的写入情况）

- `--full` 的 e2e 跑在 `VACUUM INTO` 出来的独立副本（`_dev/.test-db/workbench.db`，每轮重建），用例里的 `自检*` 规则、`r_e2e_*` 与年规则实例都只落在这个副本。
- 真实库 `data/workbench.db` 复核：`emp=9`、`task=578`、`e2e_leak=0`、`cycle='year'` 规则 `0` 条、截图专用规则 `0` 条。
- 截图实例（8790/8791）用的是 `_dev/.shot-db` / `_dev/.before-db` 两份临时副本，已删除。
- 如实说明：第一次做快照时用了读写连接打开真实库（`VACUUM INTO` 后关闭），SQLite 顺手把 WAL checkpoint 进主库文件并清掉 `-wal/-shm`；**没有业务写入**，之后的行数核对与上面的计数一致，后续快照改为 `readOnly`。


## 改了什么

### 服务端（`server.js`）

| 位置 | 改动 |
|---|---|
| `cyclesBetween` | 新增 `year` 分支：按自然年切，`key=YYYY`、`from=YYYY-01-01`、`to=YYYY-12-31` |
| `stepPlanDate` | 新增 `year` 分支：`monthNo`（1-12）+ `day`，按当月天数夹取；**不复用月规则的 `mo`** |
| `routineWindow(rule)` | 窗口按周期分档：日/周/月 `+80d`，年 `+366d`（今年 + 明年） |
| `ensureInstances` | 年节点只生成落在窗口内的那一次；`stages` 增加 `monthNo` 字段 |
| `regenRule` | 删除范围从「本月及以后」改为「本次生成窗口内」，窗口外年实例不再被删 |
| `upsertRule` | 周期白名单 `day/week/month/year`，未知周期返回可读文案；年节点校验 `monthNo`/`day` |
| `/api/sync` | 规则的拒收原因写入 `errors`（原先静默丢弃），前端原话提示 |

### 前端（`public/app.js`）

- 常规工作新增第四个页签「年常规」；周期下拉新增「年常规（每年一次）」。
- 节点行新增「月份（1-12 月）」下拉 + 「几日」输入；`readStepRows`/保存映射带 `monthNo`。
- `cycleCN` / `cycleLabel` / `nodeDayText` 补「每年」；年规则卡显示「每年 X 月 X 日」。
- 年实例日期用 `fmtY`（带年份）；规则卡统计文案为「今年与明年：N 个周期实例」。
- 弹窗与规则说明区的文案同步（重排范围、跨年节假日限制）。

### 文档

- `DEVELOPMENT.md`：常规工作改为日/周/月/年；`rule.cycle` 枚举；`steps` 增加 `monthNo`；生成窗口与重排范围按周期分档。
- `specs/modules/server-api.md`：周期白名单与年节点校验（拒绝点 + 反例）。
- `specs/modules/server-data.md`：窗口分档、重排只动窗口内实例。
- `specs/modules/app-ui.md`：年常规页签、月份/日期输入、年份显示。
- `specs/modules/tooling.md`：e2e 7.4b 覆盖清单。

## e2e（`_dev/e2e.mjs` 7.4b）

新增断言 9 条：

1. 年常规页签存在且可切换。
2. 年节点行有「月 / 日」输入（8 月 / 31）。
3. 实例 id 形如 `ri_<rule>_YYYY`、`plan_date=YYYY-08-31`（年份按窗口起点后最近的 8/31 动态计算）。
4. 年实例在日历目标月份可见。
5. 连续两次取 state，年实例仍是 1 条（`maintain` 幂等）。
6. 改规则到 8/30 后实例仍在、id 不变、`plan_date` 更新。
7. 日/周/月周期 key 形态回归（日/周=日期、月=YYYY-MM），不再写死条数。
8. 未知周期 `quarter` 与缺 `monthNo` 的年规则被服务端拒收并回可读原因。
9. 删除年规则后实例一起清掉。

同时修了一处**既有 e2e 日期腐烂**：拖拽夹具原写死 2026-11 且拖到 11-13，11 月中旬之后跑会被「不能拖到过去」更早拦下。夹具改为按今天平移（语义不变），否则 `--full` 永远红。

## 已知限制（按要求如实保留，不扩窗口、不改节假日）

1. **节假日表只有当年**：跨年以后遇到非工作日，`prev/next` 顺延可能只按周末算（2027 年的法定假日不在表里）。
2. **年度实例在 +366 天窗口边缘才出现**：每年节点只生成窗口内最近的那一次；如果规则设的是「每年 3 月 1 日」、当前是 11 月，明年的 3/1 在窗口内，会正常出现；但「后年」的那次不会提前造，需要等窗口推进。
3. 年节点日期按当月天数夹取（如 2 月 31 日落到 2 月最后一天），不报错。

## 兼容与回滚

- `rule.cycle` 是 TEXT、原表无 CHECK 约束，**旧数据零迁移**；日/周/月的生成窗口、key 形态、展示均未改。
- 年规则数据是普通 `rule` 行 + 普通 `task` 实例，回滚代码后仍可读；前端遇到未知周期会落进月展示，不影响其它规则。
- 回滚方式：回退本次提交即可，无数据修复脚本。

## 待办（清场后）

- ~~`version.js` bump 0.10.0 + CHANGELOG~~ 已完成（新能力 → Y 位，`--write` 生成，0.9.7 段原样保留）。
- ~~`specs/modules/version.md` 变更历史行~~ 已完成。
- 待执行：`git add` → `node _dev/verify.mjs --full` → `GATE_TASK=TASK-20261116-year-routine git commit` → `gate --ci`。
