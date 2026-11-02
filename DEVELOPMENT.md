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
version.js             # 版本号与更新内容的唯一定义点（含自检/生成命令）
CHANGELOG.md           # 更新记录的人读版本（由 version.js 生成，勿手改）
import-emp.js          # 花名册导入（CSV → emp 表，含校验与干跑）
emp-template.csv       # 花名册模板（Excel 可直接打开填写）
public/index.html      # 页面骨架与全部样式
public/app.js          # 视图渲染、交互、同步
public/changelog.js    # 顶栏版本号 + 版本更新弹窗
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

### 3.1 导入花名册（账号）

花名册就是 `emp` 表：`no`（工号）、`name`（姓名）、`role`（岗位）、`dept`（部门）、`mgr_no`（上级工号）、`active`。登录只比对工号 + 姓名，没有密码；`mgr_no` 决定可见范围（下属的常规工作进上级看板，上级下发的任务进下属承接台）。

用 `emp-template.csv` 填好，跑一条命令：

```bash
node --no-warnings import-emp.js 花名册.csv --dry-run   # 先看有没有问题，不写库
node --no-warnings import-emp.js 花名册.csv             # 校验通过后写入
```

- CSV 列：`工号,姓名,岗位,部门,上级工号`，第一行表头可有可无，`#` 开头为注释，支持 Excel 存出的带 BOM 的 UTF-8。
- 只有工号、姓名必填。上级工号可以指向本文件里的人，也可以指向库里已有的人。
- 按工号 upsert：重复导入是更新，不会出现两条；导入会把该账号 `active` 置回 1。
- 全量校验通过才写库，一行有问题整批不写（工号重复 / 姓名空 / 上级不存在 / 自己当自己上级都会被点出来），事务内写入，异常回滚。
- 写入后 `rev` 会 +1，前端几秒内自动刷新，不用重启服务。
- **离职 / 返聘**不用从 CSV 删行（删行不会改任何东西），用开关：

```bash
node --no-warnings import-emp.js --off 1005    # 停用：登录被拒，不进任何人的下属列表
node --no-warnings import-emp.js --on  1005    # 重新启用
```

`active=0` 之后登录被拒、不再出现在任何人的下属列表里，历史任务与日历记录不受影响。

> 为什么不做导入界面：一期没有权限分级，任何能打开工作台的人都能改花名册就等于能给自己加权限。导入放在命令行，由维护者执行。

## 4. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/version` | 当前版本 `{semver, version, changelog}`；`version` 为 `SEMVER+提交数.短hash`，`changelog` 无登记时为 `null`。公开只读，登录页也取 |
| GET | `/api/changelog` | 全部已登记版本倒序 `{current, versions[]}`，供「历次更新」 |
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
7. **停用 vs 删除**（两者语义刻意不重叠，别合并）：
   - **停用**：只停今后。置 `active=0`，服务端 `regenRule()` 对 `active=0` 直接 return、`maintain()` 也只补 active 的规则，所以不会再生成；前端把**明天及以后、未完成**的实例删掉，**今天及以前原样保留**（历史不断档、当天任务不被打断）。重新启用后按窗口重建。
   - **删除**：彻底删除。规则与全部实例一起清掉；不再提供「只删规则保留实例」的选项（该诉求由停用承接），但服务端仍兼容历史数据里的 `detached` 标记。
   - 启动时 `pruneOrphanRoutines()` 自愈「规则已没了、实例还挂着」的孤儿数据。
8. **节假日算法有两份**：服务端为准（生成实例用），前端仅用于规则卡预览。改算法必须两边一起改。
9. **日常规只按工作日生成**，与界面文案“每个工作日”一致；周末与法定假日不生成，调休上班日生成。

## 7. 自检

`_dev/e2e.mjs` 是端到端自检：零依赖，直接驱动本机 Chromium（CDP），覆盖登录、七个页面、日历默认月份、下属看板、勾节点落库与刷新留存、拖拽改期、空态新建、示例数据、切换身份看承接角标、版本号与更新弹窗、JS 错误与失败请求。

```bash
node version.js --check      # 版本号与更新内容自检（发版必跑）
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

## 10. 版本与发版

### 10.1 版本号在哪儿

**只有一个地方**：`version.js` 顶部的 `SEMVER`。服务端、前端、文档需要版本号时都从这里或接口取，别处不许硬编码。启动窗口和顶栏显示的 `x.y.z+N.hash` 里的提交数与短 hash 由 git 自动派生，不用管。

规则（语义化）：

| 位 | 什么时候 +1 | 例子 |
|---|---|---|
| X | 不兼容的大改：数据结构或使用方式推倒重来 | 1.0.0 |
| Y | 新功能成批上线 | 0.3.0 加「月度复盘」 |
| Z | 修复与优化；只要使用者能感知到变化就 +1 | 0.2.1 修一个日期算错 |

Z 位这条是硬要求：**用户看得见的变化不 bump 版本号，更新提示就不会触发**，使用者永远不知道东西变了。

### 10.2 更新内容写在哪儿

也是 `version.js` 里的 `CHANGELOG`：按版本号倒序排，每版含 `date`、`title`、`items[]`（分组 + 每条一句话）。

- 分组只能从四类里选：`新增能力` / `体验增强` / `口径变更` / `问题修复`，写别的自检会报错；
- 写使用者视角的人话：他能做什么、哪里不再出问题。不写表名、接口名、commit、代码细节；
- 历史版本的文字不要改，只在最前面加新的一块。

`CHANGELOG.md` 是同一份内容的 Markdown 版，**由脚本生成**，不要手改：

```bash
node version.js            # 打印完整版本串
node version.js --check    # 发版前自检：当前版本有登记、结构合法
node version.js --write    # 生成/刷新 CHANGELOG.md
node version.js --json     # 调试用：接口会返回的完整内容
```

> 为什么不用「CHANGELOG.md 手写 + 代码里再抄一份」：两份一定会走偏。这里只有一个真相，Markdown 是它的投影。

### 10.3 发一次版的步骤

1. 改 `version.js`：`SEMVER` 加一档，`CHANGELOG` 最前面加这一版的内容。
2. `node version.js --check` 通过后 `node version.js --write` 刷新 `CHANGELOG.md`。
3. 跑 `node _dev/e2e.mjs`，全绿再出门（含版本弹窗用例）。
4. 提交：`release(v0.2.1): 一句话说清这次给使用者带来了什么`。
5. 打标签并推送：

```bash
git tag -a v0.2.1 -m "v0.2.1 一句话"
git push origin main --tags
```

### 10.4 前端怎么让人知道更新了

| 场景 | 行为 |
|---|---|
| 第一次打开（本地无记录） | 只记下当前版本，**不弹** |
| 版本变了 | 自动弹「本次更新」，点「知道了」写回记录，之后不再弹 |
| 想看历史 | 点顶栏的版本号，任何时候都能翻历次更新 |
| 版本接口拿不到 | 版本号隐藏、不弹窗，业务功能照常 |

记录存在浏览器 `localStorage.cadence_seen_version`，所以每台电脑/每个浏览器各自提示一次，互不影响。

### 10.5 提交信息

- 日常改动：`fix(范围): 一句话` / `feat(范围): 一句话` / `docs(范围): 一句话`，范围用中文模块名（如 `常规工作`、`日历`、`版本`）。
- 发版单独一个 `release(vX.Y.Z): 这版给使用者带来了什么`，只包含 `version.js` 与 `CHANGELOG.md` 的改动。这样回看历史时，能一眼把「发版」和「功能提交」分开。
- 一次提交只做一件事；版本号与更新内容永远和它描述的那批改动一起进来。

## 11. 已知边界（一期）

无密码、无权限分级、无推送（仅站内）、无验收评分、无组织架构同步、未适配移动端、并发写为后写覆盖。**仅限试点范围使用。**
