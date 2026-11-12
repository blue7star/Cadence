# Delivery — TASK-20261112-rules-conflicts

## 改了什么

| 文件 | 改动 |
|---|---|
| `AGENTS.md` | G0 取消快路径：所有改动统一 `--full`；「碰了就不是 G0」改为「碰了就不算微调」 |
| `.agents/README.md` | 写明 `gate.py` 管 M1–M8，`verify.mjs` 的 `contracts()` 只校验 2026-11-04 前归档契约 |
| `.agents/review-checklist.md` | A2/A4/D4 改绑 `delivery.md` 与 `verdict.md` 候选摘要；B11 视口改为与 e2e `--window-size` 一致（1600×1000）；D3 改 semver 三档 |
| `.agents/archive/README.md` | 归档契约整份只读，第 3 段不得补写、不得改 PASS |
| `.agents/practice/ai-native-engineering.md` | 证据指针改为 `verify.mjs` 退出码；追加 8 对矛盾的裁决记录，声明旧证据表失效 |
| `specs/modules/version.md` | INV-4 改为 semver 三档（修复 Z / 新能力 Y / 破坏 X） |
| `specs/modules/app-ui.md` | 删除只在前端存在的 INV-4 周末规则；纸面视口与 e2e 对齐 |
| `specs/modules/{tooling,app-ui,version}.md` | 各补一行本任务变更历史 |

## 没做什么

- 未改任何业务代码：`server.js`、`public/app.js`、`version.js`、`_dev/`、`gate.py` 均未动。
- 未删纯重复项、未做「降级为代码判定」；留给 `TASK-20261112-rules-dedup`。
- 未自签 PASS、未写 `verdict.md`，判定留给独立复核。

## 验证

- `node _dev/verify.mjs --full`：见提交前运行结果（`git add` 后重跑）。
- `python .agents/gates/gate.py --ci --repo .`：提交后运行，原始输出另附。

## 已知边界

- 本批只有 PLANNED/IN_PROGRESS，无 PASS 事件，`gate --ci` 预期为 `no_evidence` 退出 1；这是流程未走完，不是文档改动失败。
- `SPEC.md` / `app-ui` 的旧变更历史保留「INV-1~INV-4 落地」字样，属历史事实，不改写。
