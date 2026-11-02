# Cadence · 开发说明

面向开发者与运维。业务侧使用说明见 [README.md](README.md)。

## 1. 是什么

面向初级管理者的工作台：下发任务、常规工作（日/周/月固定节点）、专项工作、临时任务、日历待办、承接上级任务。

- 形态：单进程 Web 应用。`server.js` 同时提供 REST 接口与静态页面。
- 后端：Node.js **22+**（依赖内置 `node:sqlite`），零第三方依赖，`npm install` 不需要跑。
- 前端：原生 JS 单页，无框架、无构建步骤，`public/` 目录即产物。
- 存储：SQLite 单文件 `data/workbench.db`（首次启动自动建表）。

## 2. 目录

```
server.js              # HTTP 服务 + 接口 + 常规实例生成引擎
public/index.html      # 页面骨架与全部样式
public/app.js          # 视图渲染、交互、同步
data/                  # 运行时数据库（已 gitignore）
docs/product-design.html  # 产品设计方案（含一期范围、权限、决策记录）
docs/prototype.html       # 交互原型（无后端，localStorage，供对照）
启动工作台.bat / 停止工作台.bat  # Windows 一键启停
readme-no-node.txt     # 未安装 Node 时的提示（由 bat 用 type 输出）
_dev/                  # 本地自检脚本与产物（已 gitignore）
```

## 3. 本地运行

```bash
node --no-warnings server.js          # 默认 8788
PORT=8799 node --no-warnings server.js   # 换端口
```

启动后可访问 `http://localhost:8788`，用种子花名册里的 **1012 / 王磊** 登录。路由用 `/api/login`、`/api/state`、`/api/sync`、`/api/rev`、`/api/setmgr`、`/api/demo`、`/api/reset`。

## 4. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/login` | `{no, name}`，比对 `emp` 表；返回身份、上级、可见下属 |
| POST | `/api/setmgr` | 首次登录自选直属上级，服务端做防环校验（不能是自己或自己的下级） |
| GET | `/api/state?me=<工号>` | 一次返回该用户可见的全量数据（含服务端生成的常规实例） |
| GET | `/api/rev` | 全局版本号，供前端 7 秒轮询；变了才拉全量 |
| POST | `/api/sync` | 增量提交：`{me, tasks[], rules[], cats[], watch[], del:{...}}`，服务端校验归属后落库 |
| POST | `/api/demo` | 注入示例数据（王磊的产品组） |
| POST | `/api/reset` | 清空当前用户业务数据 |

## 5. 数据模型

| 表 | 用途 | 关键字段 |
|---|---|---|
| `emp` | 花名册 | `no`(PK) `name` `role` `dept` `mgr_no` `active` |
| `rule` | 常规工作规则 | `id` `owner_no` `cycle(day/week/month)` `policy` `steps`(JSON) `active` |
| `task` | 所有任务 | `type(assign/special/temp/routine)` `owner_no` `assignee_no` `start_date` `end_date` `stages`(JSON) `routine_id` `plan_date` `source_id` `detached` `intake_status` |
| `cat` | 两级分类 | `lvl` `parent_id` `name` |
| `watch` | 管理者关注的“下属+规则” | `mgr_no` `sub_no` `rule_id` |
| `holiday` | 节假日与调休 | `date` `kind` |
| `op_log` | 操作日志 | `actor_no` `action` `detail` `ip` |
| `meta` | 版本号等 | `k` `v` |

`rule.steps` 单节点结构：`{name, time, day|weekday, mo, plan, policy}`。`mo` 为月份偏移（0 本月、1 次月），用于跨月规则（如本月 28 日 → 次月 15 日）。

## 6. 关键设计（改动前先读）

1. **常规实例由服务端生成，不由浏览器生成。** 管理者要看下属的推进情况，下属没登录也必须存在实例。`maintain()` 在每次取 `state` 前按 `today-40d ~ today+80d` 补齐；实例 ID 固定为 `ri_<ruleId>_<周期key>`，`INSERT OR IGNORE` 保证幂等。
2. **前端不存业务数据。** `localStorage` 只放工号。`save()` 与上次同步快照做 diff，POST `/api/sync` 提交增量；连续操作走队列，避免“边存边刷新”把未推送的改动冲掉。
3. **同步是拉模式。** 前端每 7 秒 GET `/api/rev`，版本号变了才拉全量；拉回时若弹窗或抽屉开着则延迟重渲染。
4. **可见范围**：自己创建的 ∪ 指派给自己的 ∪ 下属的常规工作。下属的专项、临时任务管理者看不到。
5. **承接链路**：上级下发 → 下属「承接台」`intakeStatus=pending` → 承接后生成自己的任务（`source_id` 指回原任务），原任务置 `accepted`。`pending` 的下发任务不进下属的今日待办，避免重复。
6. **规则变更重排**：按“周期归属月”重建当月及以后的实例，仅恢复 `date <= today` 的已勾选节点；已勾选的历史不丢。
7. **删除规则**：默认连带删除实例；也可选择保留实例并打 `detached` 标记。启动时 `pruneOrphanRoutines()` 自愈历史遗留的孤儿实例。
8. **节假日算法有两份**：服务端为准（生成实例用），前端仅用于规则卡预览。改算法必须两边一起改。
9. **日常规只按工作日生成**，与界面文案“每个工作日”一致；周末与法定假日不生成，调休上班日生成。

## 7. 自检

`_dev/e2e.mjs` 是端到端自检：零依赖，直接驱动本机 Chromium（CDP），覆盖登录、七个页面、日历默认月份、下属看板、勾节点落库与刷新留存、拖拽改期、空态新建、示例数据、切换身份看承接角标、JS 错误与失败请求。

```bash
node _dev/e2e.mjs            # 需先起服务，默认 http://localhost:8788
```

脚本里的 Chromium 路径取自本机 Playwright 缓存，换机器需要改 `_dev/e2e.mjs` 顶部的 `CHROME` 常量。产物（截图）在 `_dev/shots/`。`_dev/` 不进版本库。

## 8. 换机器部署

1. 目标机装 Node.js 22+。
2. 拷贝整个目录（或 `git clone`），**不要** 带 `data/`（会自动重建）。
3. 双击 `启动工作台.bat`，窗口里会显示本机与局域网地址。
4. 若同事打不开：检查该机防火墙是否放行端口。Windows 防火墙里“阻止”优先于“放行”，存在针对 `node.exe` 的入站阻止规则时，加放行规则也无效，需要删除阻止规则或由 IT 出策略。

## 9. 代码约定

- `.bat` 必须 **CRLF + 纯 ASCII**。cmd 解析 LF 结尾的批处理会把整个文件当成一行；批处理里混入 UTF-8 中文会导致字节偏移错位，后面的行被截断执行（历史上导致过“启动窗口全黑”）。中文提示交给 node 输出，或用 `type readme-no-node.txt` 原样打印。
- `.gitattributes` 已固定 `*.bat text eol=crlf`，clone 后无需手动转换。
- 前端不引入构建工具与第三方库，保持“拷过去就能跑”。
- 数据库结构变更写在 `server.js` 建表处，并对老库做兼容（`ALTER TABLE` 前先查 `pragma table_info`）。

## 10. 已知边界（一期）

无密码、无权限分级、无推送（仅站内）、无验收评分、无组织架构同步、未适配移动端、并发写为后写覆盖。**仅限试点范围使用。**
