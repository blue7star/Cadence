# MOD-tooling · 花名册导入与自检门禁

paths: _dev/, import-emp.js, .agents/gates/, .agents/templates/, .agents/scripts/, .agents/schemas/, .agents/README.md, .agents/SPEC.md, .agents/review-checklist.md, .githooks/, .github/workflows/, specs/modules/, specs/features/, AGENTS.md

## 职责
`import-emp.js`（CSV → `emp`）与自检（`_dev/e2e.mjs` 端到端断言、`_dev/verify.mjs` 提交门禁）。

## 公开行为
- `import-emp.js`：`--dry-run` 预检、`--apply` 写库、`--on/--off` 启停用；按工号 upsert。
- `verify.mjs`：`--fast`（语法+版本+CHANGELOG 一致性）、`--full`（+服务版本+e2e）、`--hook`（复核树摘要）。

## 不变量
- 导入不带 `--apply` 绝不写库；全量校验通过才写，一行有问题整批不写（事务回滚）。
- `e2e.mjs`：每条用户可见行为都要有对应断言；**不许为了让测试变绿而放宽断言**。
- `verify.mjs`：摘要覆盖未提交/未跟踪文件；`--full` 才算数；「验过之后又改了」必须拦。

## 依赖与边界
- `e2e.mjs` 驱动本机 Chromium CDP，零依赖。
- 脚本进版本库；截图/报告（`_dev/shots/`、`_dev/verify-report.json`）进 `.gitignore`。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths:`：门禁/模板/钩子归本模块；M8 受理闸与 `--selftest` 落地 |
