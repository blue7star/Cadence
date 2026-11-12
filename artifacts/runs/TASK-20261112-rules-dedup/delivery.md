# Delivery — TASK-20261112-rules-dedup

## 改了什么

- 删除 **49 条**「纯重复 / 已被代码或 e2e 覆盖」的文档规则表述，逐条凭据（原文位置 / 原来挡什么 / 现在靠什么兜）已追加到 `.agents/practice/ai-native-engineering.md` 的「2026-11-12 第二批删除凭据」表。
- `AGENTS.md`：删 G2 四类触发面、契约面下限五项、fail_source 八类表、不换 VERSION、其余红线指针、pre-commit 两条细节、`--hook` 同一套；改为指向 `protected.json` / `issues.md` / 钩子实现。
- `.agents/README.md`：删 8 条与 `gate.py` 实现重复的说明（受保护面、M8 五字段、selftest 条数、--scope、M4、提交点/合并点、派生账本、block 情形表）。
- `.agents/issues.md`：删「一个编号只能被一份契约挂」；把重复的 `#64` 中「摘要过期」那条改为 **#66** 并结案（0.9.2 已整体撤掉摘要/报告/锚点）；统计改为 **66 条（未解决 11、已解决 55）**，与表内行数一致。
- `.agents/review-checklist.md`：删 A1-A4、B2-B6、D2；A 节保留一句「由 verify/gate 判定，清单不重复」。
- `specs/modules/app-ui.md`：删 8 条（导出 401、ownRows、勾选框判权、派生副本只读、列表排序、INV-1 单入口、日历格子、三通道视觉）。
- `specs/modules/server-api.md`：删 4 条（登录失败上限、派发 activated/stage_ref、已派发叶子完成态、status 由叶子推）。
- `specs/modules/server-data.md`：删 6 条（实例幂等、task 三列归属、工作日生成、op_log 上限、口令/会话/导出只读、admin 分表重复）。
- `specs/modules/tooling.md`：删 3 条（导入 --apply、verify 不留凭证、PASS 绑归档提交）。
- `specs/modules/version.md`：删 2 条（分组四类、CHANGELOG 逐字一致）。
- 五份蓝图各补一行本任务变更历史。

## 没做什么

- **降级为代码判定：一条没动。**
- 没删带编号的领域不变量（`server-api` INV-1~4、`server-data` INV-1~3、`tooling` INV-1、`version` INV-4）。
- 没删 `archive/` 任何正文（整份只读）。
- 没改业务代码、没改 `gate.py`、没放宽 e2e 断言。

## 验证

- `node _dev/verify.mjs --full`：见提交前运行结果。
- `python .agents/gates/gate.py --ci --repo .`：提交后运行，原始输出另附。
- 台账核对：`issues.md` 表内行数 66，未解决 11、已解决 55；编号 64 唯一（跨年排期），66 为原摘要问题。

## 新发现的、清单之外的不一致

- `app-ui` INV-2 / INV-3（编号跟时间走、跨年提示带年份）按 `tooling` INV-1 的严格读法是「只在前端成立」的规则，与本轮删除 INV-4 的理由同源。本批按授权**没有动**，留给 Human 决定：是降级为 e2e 断言、还是改写进「公开行为」。
- `AGENTS.md` §4 仍保留「gate.py 三条边界」与 M1/M8 说明，与 `.agents/README.md` 有部分内容重叠；本批只删了 README 侧，AGENTS 侧作为主文档保留。是否继续收口，等独立复核后由 Human 定。

## 未自签

未写 `verdict.md`、未标记 PASS；判定留给独立复核。
