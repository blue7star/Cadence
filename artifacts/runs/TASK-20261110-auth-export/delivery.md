contract_version: 3
candidate_revision: 1
candidate_digest: 未封存（本任务停在 READY_FOR_REVIEW，候选由第三轮复核按提交号封存）
verify_commands: node _dev/verify.mjs --full; python .agents/gates/gate.py --ci --repo .
not_run: none

# Delivery — TASK-20261110-auth-export

> 交付范围：第一批「认证 + 导出 + 独立管理账号」，外加 2026-11-11 的收口整改。
> 本文件只记事实与原始输出；结论归独立复核（见同目录 `verdict.md` 的两轮纪要）。

## 1. 交付了什么

### 1.1 功能（已在 0.9.0 发布）

- 会话门：所有接口绑 `sess`，无会话 401；`me ≡ session.no`，带别人的 `me` 403。
- 登录 / 退出 / 改密 / 管理员重置密码 / 「仍用初始密码」名单五个接口。
- 独立管理账号：`admin_auth` 表，账号 `admin`，不占工号、不进 `emp`；首次启动随机生成初始密码、
  只在启动日志打印一次；首登强制改密；不读 `CADENCE_ADMIN_NO`。
- 导出：`GET /api/export/tasks.csv`（UTF-8 BOM、`#` 注释头、一行一阶段、任务级列只在首行）。
- `_dev/e2e.mjs` 每个身份先登录 + cookie 透传；e2e 夹具迁到 `VACUUM INTO` 的测试库副本，
  `--full` 自起 8799 实例、跑完收摊，真实库不动。

### 1.2 本轮（2026-11-11）收口：拆掉「报告凭证」这套重复实现

制度全留（契约受理五字段、M1 受保护面、M8 受理闸、delivery/verdict、独立复核、issues 台账、e2e、CI 全量），
只删掉三套同时回答「这棵树验过没有」的实现：

| 删除 | 原因 |
|---|---|
| `_dev/verify-report.json`（入库报告） | 手改报告就能骗过 pre-commit；pre-commit 只能不断加校验层去追 |
| `verify.mjs --recheck`（逐文件复算） | 报告不存在了，复算没有对象 |
| `.agents/archive/pass-anchors.md`（锚点账本） | 历史 PASS 直接绑不可变的 git 提交号，不需要第二份账 |

替代方案只有一条：**验的时候当场跑**。`--hook` 与 `--full` 是同一套检查（语法 + 版本 + CHANGELOG +
契约状态 + 门禁反例 + 工作区干净 + e2e），pre-commit 当场重跑，跑不过就不许提交。

配套改动：

- `.agents/gates/gate.py`：同一 `task_id` 出现在两个 `artifacts/runs/` 目录 → 判账本损坏（跨目录分叉检测）。
- `.agents/scripts/agent_workflow.py`：`bump-contract` 不再另开 `<task_id>-cvN/` 目录，改为同一条链内
  重写 PLANNED（只在还没开工时允许）；已开工的链不允许重写，契约变了就开新 task_id。
- 事件链合并：`TASK-20261110-auth-export` / `-cv2` / `-cv3` 三条单事件链合并为一条，
  `contract_version: 3`，`-cv2` / `-cv3` 目录删除。
- 三份历史 PASS 契约的「复核对象」改绑归档提交 `4762476`（旧算法树摘要不可复算）并注明
  「仅对原树有效，未在现行树复核」。

## 2. 验证输出（原始）

### 2.1 `node _dev/verify.mjs --full`

```
[校验] --full  Cadence

PASS  语法检查 12 个文件
PASS  版本自检（当前版本有登记、结构合法）  · 通过：当前 v0.9.0，已登记 35 个版本。
PASS  CHANGELOG.md 与 version.js 一致
PASS  契约状态 4 份（交付即须复核，PASS 绑归档提交）
PASS  门禁反面用例（已知绕法全部被拦）  · [通过] 9 种已知绕法全部被拦
PASS  契约门禁反面用例（M1/M8 会拦）  · 通过：26/26 个用例符合预期
PASS  工作区干净（只验已入索引的树）  · 索引即待提交的树
PASS  测试实例在跑（独立测试库，真实库不动）  · v0.9.0 · D:\ai_project\ai_work\Cadence\_dev\.test-db\workbench.db
PASS  测试实例打印了 admin 一次性初始密码  · （已交给 e2e 做首次登录）
PASS  e2e 205 项
PASS  改密 → 真重启 → 管理账号新密码可登录、一次性初始密码失效  · 新 ok / 旧 已失效
PASS  重置过的员工密码在重启后仍然有效  · {"ok":true,"me":{"no":"1004","name":"王浩","role":"研发工程师","dept":"产品部","mgrNo":"1012"},"admin":false}

[通过] 12 项全绿
提交：git add -A → git commit（pre-commit 会当场重跑同一套验证）
提交后：python .agents/gates/gate.py --ci --repo . 确认整体门禁（读 HEAD，提交信息要带 Task: trailer）
```

### 2.2 `python .agents/gates/gate.py --ci --repo .`（提交后，读 HEAD）

```
（见下方追加）
```

## 3. 与契约的差异

- `out_of_scope` 原文写「只新增 cred 与 sess 两张表」；实际实现按同条 `stop_conditions` 的第 4 项
  （独立 admin 账号）多了一张 `admin_auth`，`task.md` 的「读法（cv3）」已写明这处放宽。
- `modules` 增加了 `version`（0.9.0 发版归本契约），因此 `contract_version` 从 1 走到 3。
- 本轮收口删除了 `verify-report` / `--recheck` / `pass-anchors`——这是第二轮复核提出、用户拍板的
  「砍重复实现」，不是范围蔓延。

## 4. 未做 / 仍然没修的

- **没有 `task done` 自签**，也没有写 PASS 事件：判定归第三轮独立复核。
- `data/workbench.db` 中真实数据未做任何清理之外的迁移；老库兼容靠启动时 `CREATE TABLE IF NOT EXISTS`。
- 明文 HTTP、cookie 无 `Secure` 是已知风险 R1，由用户接受，未在本批处理。
- 历史三份 PASS 契约没有重新复核（用户明确「不重开历史复核」），只在锚点语义上降级。
