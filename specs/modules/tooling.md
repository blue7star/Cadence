# MOD-tooling · 花名册导入与自检门禁

paths: _dev/, import-emp.js, .agents/gates/, .agents/templates/, .agents/scripts/, .agents/schemas/, .agents/README.md, .agents/SPEC.md, .agents/review-checklist.md, .githooks/, .github/workflows/, specs/modules/, specs/features/, AGENTS.md

## 职责
`import-emp.js`（CSV → `emp`）与自检（`_dev/e2e.mjs` 端到端断言、`_dev/verify.mjs` 提交门禁）。

## 公开行为
- `import-emp.js`：`--dry-run` 预检、`--apply` 写库、`--on/--off` 启停用；按工号 upsert。
- `verify.mjs`：`--fast`（语法+版本+CHANGELOG+契约状态+门禁反例）、`--full`（+工作区干净+起测试实例+e2e+重启幂等）、`--hook`（pre-commit 调用，与 `--full` 同一套，当场跑）。

## 不变量
- `e2e.mjs`：每条用户可见行为都要有对应断言；**不许为了让测试变绿而放宽断言**。
- `e2e.mjs` 只跑在测试库副本上：`--full` 用 `VACUUM INTO` 取快照、`CADENCE_DB` 指过去；夹具（重置全员密码、删 `9xxxxx` 测试工号）不得落在 `data/workbench.db`。
- `INV-1 每条领域不变量都要能在服务端被拒收，并由 e2e 用「绕过界面直调接口」的反例证明`。前端提示不算判定；只在前端拦的规则不写进蓝图的「不变量」，改写进「公开行为」。反例：e2e 6.9 三条直调 `/api/sync` 的拒收断言。

## 依赖与边界
- `e2e.mjs` 驱动本机 Chromium CDP，零依赖。
- 脚本进版本库；截图（`_dev/shots/`）进 `.gitignore`；`_dev/verify-report*.json` 也已忽略——不再有需要入库的验证报告。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths:`：门禁/模板/钩子归本模块；M8 受理闸与 `--selftest` 落地 |
| TASK-20261110-auth-export | 见 git | — | `paths:` 补 `specs/features/`；pre-commit 支持 `GATE_TASK`；e2e 改会话身份、新增认证与导出断言、错误汇总区分预期 401；e2e 夹具迁到 `VACUUM INTO` 的测试库副本，`--full` 自起实例并补重启后密码幂等 |
| TASK-20261110-auth-export | 见 git | — | 收口：撤掉 `verify-report.json` / `--recheck` / `pass-anchors.md`，`--hook` 当场跑与 `--full` 同一套；PASS 契约改绑归档提交号；事件链按 task_id 唯一（跨目录分叉检测），`bump-contract` 改为同链重写 PLANNED；M3 暂存时按 `--task` 选契约，不再取第一份（消除 pre-commit 绿 / CI 红） |
| TASK-20261111-stage-interval | 见 git | — | e2e 6.9 新增阶段区间断言（跨年空档放行、压中间段、压最后段、首尾相接、改期自身、三条直调 `/api/sync` 拒收）；导出夹具 `e2` 由「越出父窗口的子任务」改为并列一级段（原夹具本身违反新不变量）；`review-checklist.md` 补一条「领域约束是否有服务端拒绝点与反例」；INV-1 落地 |
| TASK-20261112-rules-conflicts | 见 git | — | 规则体检第一批：取消 G0 轻口径（统一 `--full`）；修正 gate.py 与 verify 归档契约的职责表述；复核清单 A2/A4/D4 改绑 `delivery.md` / `verdict.md` 候选摘要；归档契约整份只读、不得补写第 3 段改 PASS；实践台账证据指针改为 `verify.mjs` 退出码；自审视口与 e2e 宽度对齐；版本 bump 改 semver 三档 |
| TASK-20261112-rules-dedup | 见 git | — | 规则体检第二批：删 AGENTS/README/复核清单/issues 中与门禁、e2e、其他文档重复的表述；删「导入必须 --apply」「verify 不留凭证」「PASS 绑归档提交」等已被代码覆盖的说明；issues #64 重复改为 #66 并结案，统计改为 11/55 |
| TASK-20261112-temp-daytime | 见 git | — | e2e 补快速录入条选日期的正反两条断言（落所选日、不进今日清单且日期框回默认）；蓝图 changes 随 app-ui 同步 |
