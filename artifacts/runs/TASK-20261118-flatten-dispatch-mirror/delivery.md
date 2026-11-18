# 交付 — 一级段与同名子段合并（0.16.1）

## 1. 改了什么

- 详情页一级阶段行「谁做」选人后，子专项**直接挂在这一级段上**（`parent_stage_id=一级段 id`），阶段 JSON 不再补同名、同起止的二级节点。页面只有一行：待接收显示「X 待接收」+ 改派/撤回；接收后显示「X 承接 · 状态 进度%」，进度与完成来自子专项。
- 撤回只删 pending 子专项，一级段原样保留，「谁做」立刻回来；可再派同一人或换人。
- 「+ 子任务」拆多人的路径保持不变：每条子任务一行、「含 N 个子任务」保留；下属阶段计划（只读）挂在一级行/子任务行下方展开。
- 完成态权威、三层封顶、导出父子列、可见集口径均未改。状态汇总的叶子定义改为「没有更细阶段的那一段」（`stageLeaves`），一级段自己也可以是叶子。
- 老数据迁移 `migrateFlattenDispatch()`：子专项改挂一级段 → 删除 `auto` 子段；启动时幂等执行，`node server.js --migrate` 只跑迁移并打印前后统计；执行前 `VACUUM INTO` 备份。

## 2. 迁移前后对比（真实库副本）

命令：

```
node _dev/make-copy.mjs data/workbench.db _dev/.migrate-db/before.db
$env:CADENCE_DB='_dev/.migrate-db/before.db'; node server.js --migrate
```

| 指标 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 任务行数 | 604 | 604 |
| 阶段节点总数 | 135 | 131 |
| 一级段 | 128 | 128 |
| 二级段 | 7 | 3 |
| `auto` 子段 | 4 | 0 |
| 子专项 | 4 | 4 |
| 「一级段 + 同名同起止 auto 子段」 | 4 | **0** |
| 状态分布 | todo 433 / done 166 / doing 5 | todo 433 / done 166 / doing 5 |

第二次执行 `--migrate`：`moved=0, removed=0`（幂等，不再写库）。

## 3. 真实库执行

- 备份：`data/workbench.backup-20261118-154502.db`（`VACUUM INTO`，迁移函数内自动做，仅当存在 `auto` 段时）。
- 第一次执行：`parents=2, moved=4, removed=4`；第二次执行：`moved=0, removed=0`、`backup=null`（幂等，不再写库）。
- 执行后核对：任务数 604 不变；状态分布 `todo 433 / done 166 / doing 5` 不变；子专项 4 条仍挂在对应一级段上；`duplicatePairs=0`（不存在「一级段 + 同名同起止 auto 子段」）。
- 8788 已重启到 0.16.1，`/api/version` 返回 `0.16.1`，首页 200。

## 4. 验证

- `node _dev/verify.mjs --full`：见第 5 节原始输出。
- 三视口截图（迁移后真实任务 `t7b1e0tuqm` / 21321，展开下属阶段计划）：
  - `walkthrough/1024-父任务详情-迁移后.png`
  - `walkthrough/1280-父任务详情-迁移后.png`
  - `walkthrough/1600-父任务详情-迁移后.png`

## 5. 原始输出

### 5.1 真实库迁移

```
{
  "backup": "D:\\ai_project\\ai_work\\Cadence\\data\\workbench.backup-20261118-154502.db",
  "parents": 2,
  "moved": 4,
  "removed": 4,
  "before": {
    "tasks": 604,
    "stages": { "total": 135, "top": 128, "sub": 7, "auto": 4 },
    "children": 4,
    "duplicatePairs": 4,
    "statuses": { "todo": 433, "done": 166, "doing": 5 }
  },
  "after": {
    "tasks": 604,
    "stages": { "total": 131, "top": 128, "sub": 3, "auto": 0 },
    "children": 4,
    "duplicatePairs": 0,
    "statuses": { "todo": 433, "done": 166, "doing": 5 }
  }
}
```

第二遍（幂等）：

```
{
  "backup": null,
  "parents": 0,
  "moved": 0,
  "removed": 0,
  "before": { "tasks": 604, "stages": { "total": 131, "top": 128, "sub": 3, "auto": 0 }, "children": 4, "duplicatePairs": 0, "statuses": { "todo": 433, "done": 166, "doing": 5 } },
  "after":  { "tasks": 604, "stages": { "total": 131, "top": 128, "sub": 3, "auto": 0 }, "children": 4, "duplicatePairs": 0, "statuses": { "todo": 433, "done": 166, "doing": 5 } }
}
```

### 5.2 `--full` 第 1 遍

```
[校验] --full  Cadence

PASS  语法检查 15 个文件
PASS  版本自检（当前版本有登记、结构合法）  · 通过：当前 v0.16.1，已登记 53 个版本。
PASS  CHANGELOG.md 与 version.js 一致
PASS  契约状态 4 份（交付即须复核，PASS 绑归档提交）
PASS  门禁反面用例（已知绕法全部被拦）  · [通过] 9 种已知绕法全部被拦
PASS  契约门禁反面用例（M1/M8 会拦）  · 通过：26/26 个用例符合预期
PASS  工作区干净（只验已入索引的树）  · 索引即待提交的树
PASS  测试实例在跑（独立测试库，真实库不动）  · v0.16.1 · D:\ai_project\ai_work\Cadence\_dev\.test-db\workbench.db
PASS  测试实例打印了 admin 一次性初始密码  · （已交给 e2e 做首次登录）
PASS  未改密时重启：初始口令固定为 123456，不轮换；旧密码仍可登录且仍要求改密  · 首次 123456 / 重启后 123456 / 旧 仍可用 / 新 ok / 仍要求改密 true
PASS  e2e 313 项
PASS  改密 → 真重启 → 管理账号新密码可登录、旧密码失效、且不再打印新初始密码  · 新 ok / 旧 已失效 / 重启还打印 否
PASS  重置过的员工密码在重启后仍然有效  · {"ok":true,"me":{"no":"1004","name":"王浩","role":"研发工程师","dept":"产品部","mgrNo":"1012"},"admin":false}

[通过] 13 项全绿
```

### 5.3 `--full` 第 2 遍

```
PASS  语法检查 15 个文件
PASS  版本自检（当前版本有登记、结构合法）  · 通过：当前 v0.16.1，已登记 53 个版本。
PASS  CHANGELOG.md 与 version.js 一致
PASS  契约状态 4 份（交付即须复核，PASS 绑归档提交）
PASS  门禁反面用例（已知绕法全部被拦）  · [通过] 9 种已知绕法全部被拦
PASS  契约门禁反面用例（M1/M8 会拦）  · 通过：26/26 个用例符合预期
PASS  工作区干净（只验已入索引的树）  · 索引即待提交的树
PASS  测试实例在跑（独立测试库，真实库不动）  · v0.16.1 · D:\ai_project\ai_work\Cadence\_dev\.test-db\workbench.db
PASS  测试实例打印了 admin 一次性初始密码  · （已交给 e2e 做首次登录）
PASS  未改密时重启：初始口令固定为 123456，不轮换；旧密码仍可登录且仍要求改密  · 首次 123456 / 重启后 123456 / 旧 仍可用 / 新 ok / 仍要求改密 true
PASS  e2e 313 项
PASS  改密 → 真重启 → 管理账号新密码可登录、旧密码失效、且不再打印新初始密码  · 新 ok / 旧 已失效 / 重启还打印 否
PASS  重置过的员工密码在重启后仍然有效  · {"ok":true,"me":{"no":"1004","name":"王浩","role":"研发工程师","dept":"产品部","mgrNo":"1012"},"admin":false}

[通过] 13 项全绿
```
