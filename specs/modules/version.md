# MOD-version · 版本

## 职责
版本号与每版更新内容的唯一归属者，并产出人读的 `CHANGELOG.md`。

## 公开行为
- `version.js` 导出 `SEMVER` 与 `CHANGELOG`；服务端 require 它，前端经 `/api/version` 取，`public/changelog.js` 只做展示。
- 命令：`node version.js`（打印版本串）、`--check`（自检）、`--write`（生成 CHANGELOG.md）、`--json`（调试）。

## 不变量
- `SEMVER` 是唯一版本源，且必须是 `CHANGELOG` 里最新的键。
- 分组只能用四类：`新增能力` / `体验增强` / `口径变更` / `问题修复`。
- `CHANGELOG.md` 必须与 `--write` 输出逐字一致（`verify.mjs` 会比对）。

## 依赖与边界
- 可被 `server.js`、`_dev/verify.mjs` require。
- 禁止：别处硬编码版本号字面量；手改 `CHANGELOG.md`。

## 变更历史
| task_id | commit | verdict_digest | 摘要 |
|---|---|---|---|
| — | 迁移自 `docs/modules.md` | — | 初始蓝图，历史见 git |
