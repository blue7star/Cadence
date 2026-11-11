# MOD-tooling · 花名册导入与自检门禁

paths: _dev/, import-emp.js, .agents/gates/, .agents/templates/, .agents/scripts/, .agents/schemas/, .agents/README.md, .agents/SPEC.md, .agents/review-checklist.md, .githooks/, .github/workflows/, specs/modules/, specs/features/, AGENTS.md

## 职责
`import-emp.js`（CSV → `emp`）与自检（`_dev/e2e.mjs` 端到端断言、`_dev/verify.mjs` 提交门禁）。

## 公开行为
- `import-emp.js`：`--dry-run` 预检、`--apply` 写库、`--on/--off` 启停用；按工号 upsert。
- `verify.mjs`：`--fast`（语法+版本+CHANGELOG+契约状态+门禁反例）、`--full`（+工作区干净+起测试实例+e2e+重启幂等）、`--hook`（pre-commit 调用，与 `--full` 同一套，当场跑）。

## 不变量
- 导入不带 `--apply` 绝不写库；全量校验通过才写，一行有问题整批不写（事务回滚）。
- `e2e.mjs`：每条用户可见行为都要有对应断言；**不许为了让测试变绿而放宽断言**。
- `e2e.mjs` 只跑在测试库副本上：`--full` 用 `VACUUM INTO` 取快照、`CADENCE_DB` 指过去；夹具（重置全员密码、删 `9xxxxx` 测试工号）不得落在 `data/workbench.db`。
- `verify.mjs` 不留凭证：每次当场跑，凭证就是退出码；不存在入库的报告、不存在 `--recheck` 复算。「验过之后又改了」由 pre-commit 重跑拦，不靠报告对账。
- 历史 PASS 契约的「复核对象」绑**归档提交号**（git 提交不可变），并注明「仅对原树有效，未在现行树复核」；树变了只能新开复核写新结论，不改历史锚点。锚点账本（`pass-anchors.md`）已删除。

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
