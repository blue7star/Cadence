# 交付说明 — 同层阶段重叠放行 + 三个阶段入口选人即派（v0.15.0）

task_id: TASK-20261118-stage-overlap-and-create-who
contract: v1

## 1. 同层阶段时间重叠（用户口径变更）

- `public/app.js` `validateStages` 删除第 5 条相交判定；`dragCheck` 删除「压到前/后一段」拦截，只保留子段越界与总截止。
- `server.js` `checkStageIntervals` 删除 ①（同层相交），新增「单段结束早于开始」拒绝点；②③ 原样保留。
- 前端不再出现 overlap 提示（`overlapMsg` 随之删除），拖拽时也不会出现黄色「放不下」。
- 任务周期仍由 `restatTaskSpan` / `stageEnvelope` 按 min(开始) → max(结束) 收敛。

## 2. 三个阶段产生入口统一「选人即派」

| 入口 | 改前 | 改后 |
| --- | --- | --- |
| 发布/新建任务弹窗 | 一级阶段行只有「+ 子任务」 | 每行都有「谁做」；保存后逐段调用 `POST /api/task/dispatch {topStageId, who}`，生成同名同起止二级节点 + pending 子专项 |
| 详情页「+ 添加阶段」 | 表单无「谁做」，添加后再在一级行选 | 表单新增 `#sWho`；添加并保存后立即 dispatch（`topStageId`） |
| 阶段行「+ 子任务」 | 选人只写 `who`，还需再点「派发」 | 选人并添加后立即 dispatch（`stageId`） |

- 一级阶段不落 `who`；候选与语义复用既有 `stageWhoOptions`。
- 弹窗旧提示改为「阶段行选上「谁做」就是直接派出去……等对方在承接台接收后才生效」。
- 未登录过工作台的人仍被拦（派了也收不到）。
- 弹窗保存改为异步提交：先 `await persist()` 落库，再逐段派发，按钮期间禁用，避免连点。

## 3. 校验与周期

- 前端 `readStageRows` 不再把「结束 < 开始」悄悄夹平，交给 `validateStages` 明确拒绝。
- 弹窗创建任务时起止取阶段包络（原先算出的 `span` 未被使用，已修正），总截止取 max(表单截止, 包络结束)。

## 4. 文档

- `specs/modules/server-api.md`：删除 INV-1 并写明 2026-11-18 口径变更原因；补充「结束早于开始」拒绝点；INV-2/INV-3 保留。
- `specs/modules/app-ui.md`：新增三入口与重叠放行说明；删除随功能消失的 INV-3（重叠文案不变量）。
- `.agents/SPEC.md`、`DEVELOPMENT.md`、`tooling.md`、`version.md` 同步；版本 0.15.0（新能力 → Y）。

## 验证

- `node _dev/verify.mjs --full`：13/13 全绿，e2e 294 项。
- 新增/改写断言：
  - 两段完全重叠可保存（含跨年重叠、周期延到 max）；
  - 一父两子三段互相重叠可保存；
  - 结束早于开始被拒（前端弹窗 + 服务端 `/api/sync`）；
  - 子段越出父窗口被拒（前端 + 服务端）；
  - 任务周期短于包络仍被拒；
  - 发布弹窗每行有「谁做」、保存后生成 pending 子专项；
  - 添加阶段、+ 子任务选人后立即派出；
  - 拖拽到与前一段重叠放行且无黄色提示。
- 截图：`walkthrough/01-发布弹窗两段重叠与谁做.png`、`02-保存后任务结果.png`、`03-越界仍被拒.png`（1600 视口；副本库 `_dev/.shot-db`，用完即删）。

## 已知边界

- 「选人即派」沿用的是既有 dispatch：派出的子专项仍需对方在承接台接收后才算生效；撤回/改派仍只在二级行。
- 不选人的阶段行为不变（承接人自己做）。
