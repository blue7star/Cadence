<!-- `task submit --evidence <路径>` 必填；本文件由 Reviewer 人写，工具只校验与封存，不代写。 -->

# Verdict — TASK-20261109-gate-hardening（attempt 3）

> Reviewer 输出即不可改证据；Planner 原样落盘后由 `gate.py` 封存。字段改动需同步 `schemas/verdict.json`。

## 身份（机器读）

task_id: TASK-20261109-gate-hardening
contract_version: 1
candidate_revision: 3
candidate_digest: 928e199d61877f181baa7d5ee59428b0d20bf4bc521ff268cba732b2b8d7e22e
base_revision: f7469a0c17408735af4875be77f4e93f259dfb6f
reviewer: Reviewer
reviewer_context: review-subagent-20261109-gate-hardening-a3
worker_context: planner-main-20261109-gate-hardening
attempt: 3
verdict: FAIL_IMPLEMENTATION
max_severity: P2
evidence_status: COMPLETE
not_run_count: 0
supersedes: 2

## max_severity 量表（就地定义，不依赖外部文件）

- `P0` 主链路不可用或数据错误：用户可见的核心流程失败、写入错数据、越权可读。
- `P1` 功能不可用但可绕过：某入口失效且无替代路径。
- `P2` 语义偏差与风险项：契约边界、错误码、对账口径不一致，或存在明确隐患但当前不触发。
- `P3` 体验与可维护性问题：命名、日志、性能余量。
- `NONE` 本次无 finding。

## 独立性

- 独立声明：本上下文是新开的 Reviewer 会话（`review-subagent-20261109-gate-hardening-a3`），未参与实现。只读仓库现状、契约、delivery、attempt 2 verdict（已归档 `evidence/verdict-attempt2-fail.md`）与候选补丁；先核对 `candidate-a3.patch` 的 sha256 = `928e199d…d7e22e`，与 delivery 一致。对抗探针全部建在 `%TEMP%\a2probe\repo3`（上一轮的 `repo` 被占用，另起 `repo3`），只在该临时仓库执行真实 `gate.py` 子进程；Cadence 仓库除本文件外未改动、未 `git add`/`commit`、8799 服务未停。
- 本轮复读并逐条核对的实现：`.agents/gates/gate.py` 的 `is_protected()`（L92-111）、`blueprint_paths()`（L389-417）、`path_covered()`（L419-423）、`uncovered_paths()`（L438-452）、`PLACEHOLDER_VALUE`（L576-581）、`intake_problems()`（L593-601）、`run_selftest()` 的 12 个用例（L1097-1277）；`_dev/verify.mjs` 的 `DOC_ONLY`/`EVIDENCE`/`treeDigest()`（L315-350）与 hook 绑定逻辑（L409-428）；`AGENTS.md` §2-§7；`.agents/gates/protected.json`；`.githooks/pre-commit`。
- 上轮 finding 的复核结论：F1（`--full` 不可复现）**已修**；F3（工作区回退）**已修**；F4（大小写）**已修**；F2（占位符）**只修了列举到的词，根因未修**，见 Findings。

## Findings

| ID | Severity | Class（fail_source） | Evidence | Required route |
|---|---|---|---|---|
| F1 | P2 | machine_gate_miss | M8 的占位符判定仍是「词表 + 正则」。真实模板版式探针（`modules: server-api`、改 `server.js`）：`out_of_scope: 回头补` → **M8 PASS**；`out_of_scope: 以后再补` → **M8 PASS**；`out_of_scope: 待办`、`out_of_scope: —` 同样 PASS。上一轮点名的 `TBD 稍后补`/`暂无`/`<待填>`/空/`待定，回头再补`/`看情况`/`N/A` 都已被拦（这部分确实修好），但 `回头看` vs `回头补`、`以后再说` vs `以后再补` 只差一个动词 —— 同一类漏判在 attempt 1（F4）、attempt 2（F2）、本次连续第三次出现，`selftest` 仍只把它们固定成一条字符串（`待定，回头再补`）而没有机制性兜底；attempt 2 路由要求的「`acceptance_command` 形状约束（含可执行命令 + 退出码）」也仍未实现。按 `AGENTS.md` §6「累计两次同类 fail_source，改规则而不是改代码」，这轮改的还是词，不是规则 | 不再靠词表：至少加「最短内容 + 必须含可执行命令/数字锚点（如 `--`、扩展名、`退出码`）」的形状约束，并让「补/待/回头/以后/看情况/暂无」等词族用词干匹配而不是逐个短语；把 `回头补`/`以后再补` 两条固定成 selftest 反例 |

## 证据重建与残余风险

- 重跑的命令、退出码与原始要点（全部在本机实测）：
  1. `python .agents/gates/gate.py --selftest` → **exit 0，12/12**。逐条读了实现与断言：`untracked_blueprint` 真的只在工作区写 `specs/modules/ops.md` 后断言 `M1 BLOCKED`；`placeholder_variants` 真的把 `待定，回头再补` 断言成 `M8 BLOCKED`；`case_insensitive` 断言 `is_protected("Server.js")` 与 `path_covered("server.js","Server.js")` 同时为真；`sectioned`/`partial_cover`/`stem_guess` 都走真实子进程。不是「打印通过」，但覆盖面只到已知字符串。
  2. `$env:CADENCE_BASE='http://127.0.0.1:8799'; node _dev/verify.mjs --full` → **exit 0，8 项全绿，树 `1b67a03d6ffbca60`（29 个代码文件 / 50 个文档）**。
  3. **原地再跑一次 `--full`（未动任何文件）→ exit 0，同一摘要 `1b67a03d6ffbca60`**。这是 F1 的关键验证：`artifacts/` 已移出代码摘要、改计入 `evidenceDigest`/`docsDigest`，写完证据不再让归档契约锚点失配；连续两次全绿说明「上次绿报告的摘要」与当前树摘要一致，不再是落后一代的假绿。
  4. `node _dev/verify.mjs --hook`（证据未变时）→ **exit 0**，`这棵树跑过完整校验 · 1b67a03d6ffbca60 · 07:07:23 验过`。
  5. 写入本 `verdict.md` 之后再跑 `--hook` → **exit 1**（1/7），唯一条目 `这棵树跑过完整校验 · 契约 / 台账 / 规矩改过了 → 跑 node _dev/verify.mjs --fast`；随后 `node _dev/verify.mjs --fast` → **exit 0**（6 项全绿，树仍 `1b67a03d6ffbca60`，51 个文档）；再跑 `--hook` → **exit 0**，`1b67a03d6ffbca60 · 07:07:23 验过（文档改动由 --fast 覆盖）`；最后 `--full` → **exit 0，8 项全绿，e2e 163，摘要仍是 `1b67a03d6ffbca60`**。即：证据改动**不改变代码摘要**，只要求提交前补一次秒级 `--fast` 覆盖 `evidenceDigest`——这正是 delivery 声明的行为，F1 的修复在「verdict 已存在」的前提下也成立。
  6. `python .agents/gates/gate.py --fast --staged --repo .` → **exit 0**：`M1 PASS "TASK-20261109-gate-hardening (G2) admitted, 15 protected staged paths"`、`M8 PASS 受理五字段齐备`、`M3 PASS 5 blueprints updated`。
  7. `python .agents/gates/gate.py --ci --repo .` → **exit 0**：M1/M8/M3 `no protected path changed`（`HEAD~1...HEAD` 仍是上一份 docs 提交），M2 `1 PASS events bound`、M4 `version authority: version.js`、M6 `2 snapshots verified`、M5 `0 dead links`。与上轮一样，这次绿不能证明 M1/M8 在新提交上会拦也会放。
  8. `git diff HEAD -- server.js public/` → **空（长度 0）**；`docs/adr` 不存在；`AGENTS.md` §7 仍写 M9 暂缓、M7 不引入（只认 pytest、本项目用 e2e，接了是假覆盖）、ADR 只写落点；`gate.py` 无 M9/M7 实现，selftest 里只有「不接 M9」的说明性文案。用户批准的四条取舍全部保持。
- `%TEMP%\a2probe\repo3` 对抗探针（真实 `gate.py --fast --staged`，每个用例重置到基线提交）：
  - `modules: app-ui` + 暂存 `server.js` → **M1 BLOCKED**「no declared module owns ['server.js']」（P2-1 保持修复）。
  - `modules: app-ui` + 暂存 `public/app.js` → **exit 0，M1/M8 PASS**。
  - 受理五字段写在第二个 `##` 小节 → **M8 PASS**（P1 保持修复）。
  - 占位符：`TBD 稍后补`、`暂无`、`<待填>`、空、`待定，回头再补`、`看情况`、`N/A` → **全部 M8 BLOCKED**；`回头补`、`以后再补`、`待办`、`—` → **M8 PASS**（Findings F1）。
  - 蓝图只在工作区改成 `paths: public/, server.js`、只暂存 `server.js` → **M1 BLOCKED**；未跟踪 `specs/modules/ghost.md`（`paths: *`）+ 契约 `modules: app-ui, ghost` → **M1 BLOCKED**。F3 的工作区回退确实已删（`blueprint_paths` 现在只有 `_index_text`/`_rev_text` 两条路）。
  - 直接调用判定函数：`is_protected("Server.js"/"PUBLIC/app.js"/"Public/app.js"/"public\app.js"/".GITHOOKS/pre-commit"/"data/x.db")` 全部 `True`；`"./server.js"` 仍为 `False`（git 不会产出 `./` 前缀，属残余噪声）。F4 修复确认。
- 与 Worker 证据的差异：本轮 delivery 的 `--selftest` 12/12、`--full` 8 项全绿、`--ci` 0、`--fast --staged` 0、树 `1b67a03d6ffbca60`、29 代码 / 50 文档，**全部可复现**，且第二次 `--full` 仍绿（上轮 F1 的核心诉求）。唯一不成立的是 delivery 隐含的「F2 已修复」——它只对列举过的词成立。
- NOT_RUN 清单：none（`.githooks/pre-commit` 的 sh 包装未整段执行，而是分别跑了它调用的两条轨：`verify --hook` exit 0、`gate --fast --staged` exit 0）。
- 残余风险：
  - **`paths: *` 仍是受保护面的万能钥匙**：暂存一份新蓝图 `specs/modules/ghost.md` 写 `paths: *`、契约声明 `ghost`，即可让 M1 对所有受保护路径放行（探针：`2 protected staged paths`，exit 0）。本轮不把它记为 finding：用户批准的口径是「模块归属由蓝图 `paths:` 声明」，没有规定通配符的具体性；而且新增蓝图本身是可见的受保护改动。但如果希望 M1 的「每个路径都要有归属」不被一步掏空，应拒绝 `*`/`**`/裸 `/`，要求具体文件或目录前缀。
  - 占位符是自然语言黑名单（同上 F1），真正的兜底仍是复核；建议下一轮把形状约束做完，而不是继续加词。
  - 索引里仍留着上轮遗留的 `artifacts/runs/TASK-20261109-gate-hardening/verdict.md`（`AD`：索引有旧内容、工作区已删）。本文件写入后会比索引新；提交时若不用 `git add -A`，会把旧 attempt 的 verdict 内容提交进去。属工作区卫生问题，不是门禁缺陷。
  - `--ci` 在本仓库仍然只判 `HEAD~1...HEAD`（上一份 docs 提交），对新提交的拦截能力没有被这次复核证明；真正的验证要等这次改动落成一次提交后再跑 `--ci`。
  - `is_protected` 不剥 `./` 前缀、`path_covered` 不做反斜杠归一；git 产出的路径不会带这两类形态，属低风险噪声。
  - 树摘要三把尺子刚改口径（`artifacts/` 移出代码摘要），所有历史 PASS 契约因此重锚一次；本次已按新口径对齐（`1b67a03d…`），但任何仍引用旧口径摘要的本地记录/分支都需要同样重锚。
- 判定理由：上轮四个 finding 里，F1/F3/F4 都经实测确认修好，验收命令 `--full` 连续两次可复现地全绿，`--hook` 在证据未变时绿、证据变更后只要求补 `--fast`，`--fast --staged` 与 `--ci` 均 0，产品零改动、M9/M7/ADR 取舍未变。余下的问题是 M8 的占位符检测仍靠词表，`回头补`/`以后再补` 这类同族词能直接溜过——这是用户批准的第二条要求（占位符 → BLOCKED）上的真实漏判，且同类问题已连续第三轮出现，因此判 `FAIL_IMPLEMENTATION / P2`；修改面很小（形状约束 + 词干匹配 + 两条 selftest 反例），不需要动整体设计。
