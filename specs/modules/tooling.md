# MOD-tooling · 花名册导入与自检门禁

paths: _dev/, import-emp.js, .agents/gates/, .agents/templates/, .agents/scripts/, .agents/schemas/, .agents/README.md, .agents/SPEC.md, .agents/review-checklist.md, .githooks/, .github/workflows/, specs/modules/, specs/features/, AGENTS.md

## 职责
`import-emp.js`（CSV → `emp`）与自检（`_dev/e2e.mjs` 端到端断言、`_dev/verify.mjs` 提交门禁）。

## 公开行为
- `import-emp.js`：`--dry-run` 预检、`--apply` 写库、`--on/--off` 启停用；按工号 upsert。
- `verify.mjs`：`--fast`（语法+版本+CHANGELOG 一致性）、`--full`（+起测试实例+e2e+重启幂等）、`--hook`（复核树摘要）。

## 不变量
- 导入不带 `--apply` 绝不写库；全量校验通过才写，一行有问题整批不写（事务回滚）。
- `e2e.mjs`：每条用户可见行为都要有对应断言；**不许为了让测试变绿而放宽断言**。
- `e2e.mjs` 只跑在测试库副本上：`--full` 用 `VACUUM INTO` 取快照、`CADENCE_DB` 指过去；夹具（重置全员密码、删 `9xxxxx` 测试工号）不得落在 `data/workbench.db`。
- `verify.mjs`：摘要覆盖未提交/未跟踪文件；`--full` 才算数；「验过之后又改了」必须拦。
- 历史 PASS 契约的「复核对象」不跟着新树摘要改——那是改证据。树变了只能新开复核；确实没重新复核的，在 `.agents/archive/pass-anchors.md` 里登记「契约 + 当初那棵树」的关系，门禁按这张表认锚点。

## 依赖与边界
- `e2e.mjs` 驱动本机 Chromium CDP，零依赖。
- 脚本进版本库；截图（`_dev/shots/`）进 `.gitignore`。`_dev/verify-report.json` 是证据，跟着提交进库（不忽略），否则任何人都复算不出「这棵树验过」。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths:`：门禁/模板/钩子归本模块；M8 受理闸与 `--selftest` 落地 |
| TASK-20261110-auth-export | 见 git | — | `paths:` 补 `specs/features/`；pre-commit 支持 `GATE_TASK`；e2e 改会话身份、新增认证与导出断言、错误汇总区分预期 401；历史 PASS 不再重锚树摘要，改由 `.agents/archive/pass-anchors.md` 记录锚点；树摘要改为索引 blob + LF 归一、`--full` 要求工作区干净、报告进库并支持 `--recheck` 复算；e2e 夹具迁到 `VACUUM INTO` 的测试库副本，`--full` 自起实例并补重启后密码幂等 |
