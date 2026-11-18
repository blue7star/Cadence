# Baseline — 一级段与同名子段合并

采集于 `529dc6e`（0.16.0）。

## 1. 现有形状（真实库 `data/workbench.db`，只读采集）

`node _dev/db-stats.mjs`：

```
tasks: 604
stages: total 135 / top 128 / sub 7 / auto 4
children: 4
duplicatePairs: 4   （一级段 + 同名同起止 auto 子段）
statuses: todo 433 / done 166 / doing 5
```

4 条子专项全部挂在 auto 子段上：

| 子专项 | 父任务 | auto 子段 |
| --- | --- | --- |
| `nt_tsi4yq00tb_sc_y2vptv50`（待接收） | `tsi4yq00tb` | `sc_y2vptv50` |
| `nt_tsi4yq00tb_sc_by3zfixj`（待接收） | `tsi4yq00tb` | `sc_by3zfixj` |
| `nt_t7b1e0tuqm_sc_nhctoj71`（已接收） | `t7b1e0tuqm` | `sc_nhctoj71` |
| `nt_t7b1e0tuqm_sc_n9tibzrx`（待接收） | `t7b1e0tuqm` | `sc_n9tibzrx` |

## 2. 代码落点

- `server.js` `dispatchTask` 的 `topStageId/topIndex` 分支（L1330-1362）：校验后 `stages.push({pid: top.id, 同名同起止, auto:1})`，再走通用循环建子专项，挂载点是这条新节点。
- `undispatchTask`（L1398）：`s.auto` 时 `splice` 掉节点，否则还原 `who`。
- `stageStatusFromLeaves`（L860）：叶子定义是 `stages.filter(x => x && x.pid)`；去掉中间层后一级段自己就是叶子，必须改成 `stageLeaves(stages)`。
- `syncParentFromChild`（L517）/`recomputeParentStatus`（L542）/`upsertTask`（L1059）：都以「存在二级段」为前提才重算状态，去层后会跳过。
- `toggleStage`（L1465）：先按 `x.pid` 找段，一级段取不到；需要先判 `childOfStage`。
- `public/app.js` `stageTreeHTML`（L2110-2190）：一级行只读聚合 `kidOwners`；派发/撤回/改派只在子行；下属计划只在子行展开。
- e2e 9.9b / 9.9c / 9.9d 的夹具与断言都按「一级段 + auto 子段 + 子专项」写。

## 3. 约束

- 完成态唯一真相是子专项 `status`；父阶段 JSON 不落自己的 `done`。
- 深度封顶：新任务深度 = 父深度 + 1，> 3 拒绝。
- 导出父子列（`父任务编号` / `父任务阶段编号`）口径不变。
- 可见集六来源不变；带父引用的子专项仍只从「我是承接人」进入。
- e2e 只在 `_dev/.test-db` 副本上跑；迁移验证用 `VACUUM INTO` 副本。
