contract_version: 1
candidate_revision: 9
candidate_digest: ba36315cad0ef52748267cab466c3e0099e1133fac50fdfbeaf0ac792d04c9b6
task_id: TASK-20261109-gate-hardening
verify_commands: node _dev/verify.mjs --full; python .agents/gates/gate.py --selftest; python .agents/gates/gate.py --ci --repo .
not_run: none

# Delivery — TASK-20261109-gate-hardening（attempt 9）

> attempt 1：`FAIL_IMPLEMENTATION / P1`——受理字段跨小节读不到。
> attempt 2：`FAIL_IMPLEMENTATION / P1`——交付态过不了自己的验收命令（F1）+ F2/F3/F4。
> attempt 3：`FAIL_IMPLEMENTATION / P2`——受理字段仍靠词表；`acceptance_command` 无形状约束；`paths: *` 可一次认领整棵树。
> attempt 4：`FAIL_IMPLEMENTATION / P2`——形状规则改成关键词判词后**误杀**正常答案。
> attempt 5：`FAIL_IMPLEMENTATION / P1`——占位符用子串匹配，`待办`/`稍后` 是产品核心用词，合法原话被判占位。
> attempt 6：`FAIL_IMPLEMENTATION / P2`——改成整值相等后，加个语气词或一层括号（`以后再补吧`、`TBD（待补）`）就能绕过，属本轮回归。
> attempt 7：`FAIL_IMPLEMENTATION / P2`——语气词归一了但标点没归一，`以后再补…`、`以后再补吧～`、`待办（回头再补）…` 仍放行。
> attempt 8：`PASS / P3`——F1 关闭，39 例探针零泄漏零误杀；唯一 P3 是 `.agents/README.md` 的 selftest 计数还写着「六种情况」。
> 本版只按该 P3 改了那一行文档（`--selftest` 覆盖范围 + 当前 26 条），**代码零变化、树摘要仍 `f224ef334ec7aa31`**。

## 交付内容（全部在工具/文档面，不改产品行为）

### 闸 0 · 摘要口径：证据不再算进代码摘要（issues #64，F1 的根因）

- `_dev/verify.mjs`：`artifacts/`（契约、交付、verdict、事件账本、候选补丁）不再计入代码摘要 `digest`，改计入 `evidenceDigest` / `docsDigest`。
- 原因：写一条证据就改一次代码摘要 → 刚验完的树立刻变成另一棵树 → 归档契约的复核锚点永远落后一代 → 下次 `--full` 必红 → 最后只能 `--no-verify`。
- 实测：本轮写完 delivery/verdict/候选补丁后再跑 `--full`，树摘要仍是 `f224ef334ec7aa31`，8 项全绿。

### 闸 1 · 受保护面接回真实代码（M1）

- 新增 `.agents/gates/protected.json`：`server.js`、`version.js`、`import-emp.js`、`AGENTS.md`、`.agents/SPEC.md`、`public/`、`_dev/`、`specs/`、`data/`、`.agents/{templates,gates,scripts,schemas}/`、`.githooks/`、`.github/workflows/`、`*.bat`。
- `is_protected()` 读该配置；配置缺失抛错（fail closed），不再退回脚手架默认值 `app/`。
- `is_protected` / `path_covered` 统一 casefold + 斜杠归一，`Server.js` 不再绕过（F4）。
- 模块归属改为蓝图 `paths:` 声明：`server-api.md → server.js`、`server-data.md → server.js, data/`、`app-ui.md → public/`、`version.md → version.js`、`tooling.md → _dev/、工具脚本与治理文档`；删除「拿文件名当模块名」的 stem 判断。
- `uncovered_paths()` 要求每一个受保护路径都有归属模块（声明 `app-ui` 顺带改 `server.js` 也拦）。
- `blueprint_paths()` 只读索引（staged）/ HEAD（CI）；取不到当「没有声明」，不回退工作区（F3）；含 `*` / `?` 的条目一律视为没声明（`paths: *` 不能认领整棵树）。

### 闸 2 · M8 受理闸（只判「有没有写」，不判「写得像不像」）

- `task.md` 新增受理五字段：`requirement_quote` / `user_problem` / `out_of_scope` / `acceptance_command` / `stop_conditions`；模板与 `schemas/task.json` 同步。
- `check_m8` 的判定只有四步：
  1. 缺失 → BLOCKED；
  2. 是 `-` / `none` / `null` / `N/A` / `—`，或**整句都在说「回头再补」**（整值/全分段匹配，不做子串匹配）→ BLOCKED；
  3. **实质内容太少**（按字符数）→ BLOCKED；
  4. 两个客观形状：**原话必须带引号**；**验收命令必须是一条命令 + 期望结果**（`python|node|git|…` 或 `*.mjs/*.py/*.bat/*.sh`，且含 `退出码|exit code|返回 0|期望…通过`）。
- **占位符必须整值判定，且判到等价类**：attempt 5 用子串匹配，`待办`、`稍后`、`随便` 是本产品核心用词，`requirement_quote: 用户说「待办列表点开就卡」` 会被判占位——守规矩反而无路可走。现在先按标点切段，每段先摘括号补注、再从两端剥语气词/补注（`吧`/`一下`/`内容`/`暂时`…），每剥一步重比词表；剥完正好等于占位词才算占位。`待定，回头再补`、`TBD 稍后补`、`以后再补吧`、`待定一下`、`暂无内容`、`暂时不需要停止`、（仅一个）`—` 全部拦；`待办列表点开就卡，先修这个`、`不改待办排序`、`先停` 仍放行。
- **刻意不做语义分类**：attempt 4 用「必须含不/停」这类关键词判词，把「本次范围限于工具与文档，M9 留待后续」「需要改动产品行为时先与用户确认再继续」判成 BLOCKED——误杀的摩擦会把人逼到 `--no-verify`，比漏判更糟。本轮已撤掉这些判词，并加正例 selftest 锁住。
- `parse_text` 全文件扫描 snake_case 字段（旧实现在元信息块后第一个空行 `break`，真实模板的 `## 受理` 小节读不到）。
- 只对 `rule_epoch >= 4` 的新 run 生效；`agent_workflow.py` 的 `RULE_EPOCH` 由 3 提到 4，旧证据不追溯。

### 闸 4 · 执行点

- `.githooks/pre-commit` 跑两条：`node _dev/verify.mjs --hook` + `python .agents/gates/gate.py --fast --staged --repo .`；缺 node 或 python 一律失败退出。
- CI job 名 `gate (M1-M6)` → `gate (M1-M8; M9 未启用)`：名字里保留 M9 口径，但明说它没在跑，不让人误以为 M9 已启用。

### 门禁自己的反例（26 个）

- M1：正例放行、摘要漂移拦、模块不拥有该文件拦、只覆盖部分路径拦、未跟踪蓝图扩权拦、`paths: *` 拦、`Server.js` 大小写仍受保护。
- M8 反例：停条件空拦、`<待填>` 拦、`TBD 稍后补` 拦、`待定，回头再补` 拦、`以后再补` 拦、`不排除任何东西` 拦、`不需要停止` 拦、`—` 拦、验收命令没有期望结果拦、原话没有引号拦。
- M8 占位符等价类（attempt 6 的 F1）：`以后再补吧`、`回头再补一下`、`待定一下`、`看情况吧`、`暂无内容`、`以后再说吧`、`TBD（待补）`、`待办（回头再补）`、`暂时不需要停止`；再叠一层标点（attempt 7 的 F1）：`以后再补…`、`以后再补吧～`、`待办（回头再补）…`、`待定…，回头再补`——全部判占位。`待办列表点开就卡，先修这个`、`不改待办排序`、`先停`、`卡住了`、`待办列表点开就卡……`、`先暂停导入，等我确认口径再说` 判非占位。另有端到端用例让 `以后再补吧` 真跑一遍 M8。
- M8 正例（防误杀）：「范围限于工具，留待后续」放行、「先与用户确认再继续」放行、「口径不清时与用户确认」放行、原话含「待办」二字放行、停条件含「稍后」二字放行；受理字段写在第二小节可读。
- 兼容：旧 epoch 不追接受理字段。
- 接进 `verify.mjs` 的 `gateContractSelftest()`，`--fast` / `--hook` / `--full` 都会跑；缺它视为该闸不存在。

### 配套文档

- `AGENTS.md`：G1 恢复「动手前先写 task.md」；§4/§5 写清 M1/M8、`protected.json`、`--selftest`、pre-commit 双轨与 fail closed；§7 记 M9 暂缓、M7 不引入（只认 pytest，本项目用 e2e）、ADR 暂不建目录（落点 `docs/adr/NNNN-主题.md`）。
- `.agents/README.md`：M1–M8、`--fast --staged`、`protected.json`、`--selftest`、block 条件表补 M8 与 paths 归属。
- `.agents/review-checklist.md`：新增 B11（可见界面改动必须留截图/录屏并逐条勾 B8-B10，存 `artifacts/runs/<task_id>/walkthrough/`）。
- `.agents/templates/{task,delivery}.md`：受理五字段；`verify_commands` 从 pytest 改成本项目真实命令（verify + gate）。

### 归档契约重锚（gate 机制要求，非行为改动）

- 三份历史 PASS 契约的复核树摘要更新为 `f224ef334ec7aa31`，并写明：本次只动 `.agents/gates`、`.githooks`、`.github/workflows`、`_dev/verify.mjs`、`specs/modules` 与文档，未动 `server.js` / `public/`。

## 验证证据（本机实测）

```
$ python .agents/gates/gate.py --selftest
...（26 条逐条列出）
通过：26/26 个用例符合预期

$ node _dev/verify.mjs --full
PASS  语法检查 12 个文件
PASS  版本自检（当前版本有登记、结构合法）  · 通过：当前 v0.8.5，已登记 34 个版本。
PASS  CHANGELOG.md 与 version.js 一致
PASS  契约状态 4 份（交付即须复核，复核绑树摘要）
PASS  门禁反面用例（已知绕法全部被拦）  · [通过] 7 种已知绕法全部被拦
PASS  契约门禁反面用例（M1/M8 会拦）  · 通过：26/26 个用例符合预期
PASS  服务在跑，且版本与本机代码一致  · v0.8.5
PASS  e2e 163 项
[通过] 8 项全绿 · 树 f224ef334ec7aa31（29 个代码文件 / 62 个文档）
```

本文件与 verdict 写入 `artifacts/` 不会改变代码摘要（#64 修复），提交前复跑仍绿；证据改动由提交前一次 `--fast` 覆盖。

## 改动前 vs 改动后（同一动作）

| 动作 | 改动前 | 改动后 |
|---|---|---|
| 改 `server.js` 不带契约提交 | M1 看不到该路径 → PASS | M1 `BLOCKED` |
| 契约写 `modules: server-api`、改 `server.js` | stem 匹配不上 → BLOCKED（误判） | 蓝图 `paths: server.js` → 放行 |
| 契约写 `modules: app-ui`、只改 `public/app.js` | stem 匹配不上 → BLOCKED（误判） | `paths: public/` → 放行 |
| 声明 `app-ui`，顺带改 `server.js` | 「命中一个即放行」→ PASS | 每个路径都要有归属 → `BLOCKED` |
| 临时写一份未跟踪蓝图 `paths: server.js` | 回退读工作区 → 扩权放行 | 索引/HEAD 里没有 → `BLOCKED` |
| 蓝图写 `paths: *` | 一次认领整棵树 | 通配符视为没声明 → `BLOCKED` |
| 用 `Server.js` 拼写改产品代码 | 大小写敏感 → 不受保护 | casefold → 受保护，走契约判定 |
| `out_of_scope` 空着 / `<待填>` / `TBD 稍后补` / `待定，回头再补` / `以后再补` / `N/A` | 无检查或漏判 | M8 `BLOCKED` |
| `out_of_scope: 以后再补吧` / `待定一下` / `暂无内容` / `TBD（待补）` | 整值相等时漏判（attempt 6 回归） | 等价类归一 → M8 `BLOCKED` |
| `out_of_scope: 以后再补…` / `以后再补吧～` / `待定…，回头再补` | 语气词归一了、标点没归一（attempt 7 回归） | 边缘字符归一 → M8 `BLOCKED` |
| 正常答法「范围限于工具，留待后续」「先与用户确认再继续」 | 无检查（attempt 4 的判词版会误杀） | 放行（不做语义判词） |
| `acceptance_command: 跑一下看看` | 无检查 | 缺命令/期望结果 → `BLOCKED` |
| `requirement_quote` 不引用原话 | 无检查 | 缺引号 → `BLOCKED` |
| 受理字段写在模板第二个小节 | 旧解析器读不到 → 恒 BLOCKED | 全文件扫描 → 正常受理 |
| 写完交付/verdict 再跑 `--full` | 代码摘要变了 → 契约锚点失配 → 必红 → 诱发 `--no-verify` | 证据不进代码摘要 → 仍绿 |
| pre-commit | 只跑 verify，不跑 gate | 两条都跑，缺 python 直接失败 |

## 明确未做

- 不做 M9（契约先行）：两次提交摩擦大，先观察 M1+M8 的实际拦截率。
- 不接 M7：只认 pytest，本项目用 e2e，接了是假覆盖（已写入 AGENTS.md §7）。
- 不建 `docs/adr/` 空目录，只在 AGENTS.md 写明落点。
- 不动 `server.js` / `public/`，产品行为零变化。

## 残余风险

- `.agents/gates/protected.json` 是人工名单：漏列某个文件等于它不受保护。当前按「会改运行行为或治理规则」枚举，`docs/`、`README`、`CHANGELOG` 故意不列。
- 蓝图 `paths:` 同属人工维护；文件挪位置而蓝图没改，M1 会报「没有归属」——有意的 fail closed。
- M8 的占位符判定已收到「占位词 + 语气词 + 边缘标点 + 括号补注」这一等价类，但词表仍是枚举：换个没列进词表的说法（如「过两天写」）仍可能漏；真正兜底仍是复核。
- 旧 run（rule_epoch 3）不追接受理字段，属规则升级的既定例外。
- #64 的修复改变了代码摘要口径：归档 PASS 契约的锚点因此失效一次，本次已按新口径重锚并写明依据。
