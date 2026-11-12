# MOD-version · 版本

paths: version.js

## 职责
版本号与每版更新内容的唯一归属者，并产出人读的 `CHANGELOG.md`。

## 公开行为
- `version.js` 导出 `SEMVER` 与 `CHANGELOG`；服务端 require 它，前端经 `/api/version` 取，`public/changelog.js` 只做展示。
- 命令：`node version.js`（打印版本串）、`--check`（自检）、`--write`（生成 CHANGELOG.md）、`--json`（调试）。

## 不变量
- `SEMVER` 是唯一版本源，且必须是 `CHANGELOG` 里最新的键。
- `INV-4 版本号按 semver 本义递增`：修复 bump Z、新能力 bump Y、破坏性变更 bump X（0.x 阶段的破坏性变更可用 Y）。登记在 `version.js` 并跑 `--write`；拒绝点：`verify.mjs` 的「版本自检」；反例：`node version.js --check` 在 `SEMVER` 未登记时退出非 0。

## 依赖与边界
- 可被 `server.js`、`_dev/verify.mjs` require。
- 禁止：别处硬编码版本号字面量；手改 `CHANGELOG.md`。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
| TASK-20261109-gate-hardening | 见 git | — | 新增 `paths: version.js`：模块归属由蓝图声明 |
| TASK-20261110-auth-export | 见 git | — | 0.9.0：认证与导出、独立管理账号；版本权威仍是 `version.js`（`--check` / `--write`） |
| TASK-20261111-stage-interval | 见 git | — | 0.9.2：阶段区间校验按「区间相交」重判，跨年排期不再误报；补 INV-4（用户可见的修复必须 bump Z） |
| TASK-20261112-rules-conflicts | 见 git | — | INV-4 改为 semver 三档口径：修复 bump Z、新能力 bump Y、破坏性 bump X（0.x 可用 Y）；删除「用户可见变化一律 bump Z」 |
| TASK-20261112-rules-dedup | 见 git | — | 删除「分组只能四类」与「CHANGELOG 逐字一致」两条，均由 `version.js --check` 与 `verify.mjs` 自动校验；保留 SEMVER 唯一源与 INV-4 |
