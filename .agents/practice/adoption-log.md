# 采纳记录：ai-native-engineering（部分采纳）

> **后续状态（2026-11-04）**：本项目已转为「完全落实」，工具层（`gate.py` / `agent_workflow.py`）已接入双轨门禁。
> 本记录保留 11-03 的判断原貌；后续进展见 `.agents/practice/skill-feedback-20261104.md`。
> **文中路径为 11-03 时的位置**，现已迁移：`docs/modules.md` → `specs/modules/`、
> `docs/contracts/` → `.agents/archive/contracts/`、`docs/review-checklist.md` → `.agents/review-checklist.md`、
> `docs/adoption-log.md` → 本文件、`issues.md` → `.agents/issues.md`。

2026-11-03 · 来源 `D:\ai_project\ai-skills\skills\ai-native-engineering` · 方式：**选择性采纳，不整包接入**

> 这份记录回答两个问题：**这套方法里哪些真的用上了、用出什么效果**，以及**哪些明确不用、为什么**。
> 下一季回头看，先读第 2 节的数字，再决定要不要扩大采纳面。

## 1. 采纳了什么

| 方法要素 | 落地文件 | 为什么值得 |
|---|---|---|
| 事实单一归属 | `AGENTS.md` | 只写指针表，不抄正文。之前「业务看哪、工程看哪」靠人记，七版改动堆在一起时就分不清了 |
| 模块边界（OWNED / 不变量 / 依赖方向） | `docs/modules.md` | 直接暴露了最疼的一块：`app.js` 2158 行无导出，纯逻辑只能靠 e2e 验（→ `issues.md` #12） |
| 变更契约 | `docs/contracts/_template.md` | 把 task / delivery / verdict 三份压成一页三段。G2 改动才写，G0/G1 不写 |
| 独立复核 | `docs/review-checklist.md` + 契约第 3 段 | 复核人只拿「契约 + 代码 + 树摘要」，不看实现者的解释 |
| 可执行门禁 | `_dev/verify.mjs` + `.githooks/pre-commit` | 见第 3 节：**自建，没用它的 `gate.py`** |
| 证据绑定到候选 | `_dev/verify-report.json` 里的树摘要 | 摘要覆盖未提交/未跟踪文件；「验过之后又改了」会被拦，事后也能证明「这份证据评的是这版代码」 |
| 问题归因（fail_source） | `issues.md` | 14 条历史问题归完类才发现：代码写错只有 1 条，5 条是开工前没说清口径 |
| 提交纪律 | `AGENTS.md` 第 3 节 | 直接补交了积压的 0.4.7–0.4.13 |
| 测试双轴（T1/T2/T3） | 只做了 T3（e2e），T1 **明确没做** | 原因见第 4 节，不装样子 |

## 2. 实测数据

| 指标 | 采纳前 | 采纳后 |
|---|---|---|
| 进版本库的文件 | 17 个（`_dev/` 整目录被忽略，**76 项 e2e 不在库里**） | 30 个（e2e、门禁、探针脚本入库；截图/报告仍忽略） |
| 未提交的版本 | 0.4.7–0.4.13 共 7 个 | 0 |
| 提交有无强制校验 | 无（全凭自觉跑 e2e） | `pre-commit` 强制：语法 + 版本 + CHANGELOG 一致 + 服务版本 + e2e 76 项 |
| `audit_adoption.py` 识别到 | `discovered: []` | `discovered: ["AGENTS.md"]` |
| `gate.py --ci`（skill 自带门禁） | `status: pass`（当时 7 个版本未提交） | `status: pass`（此时 30 个文件未提交，仍 pass） |
| 自建门禁对本仓库 | — | 通过时 5 项全绿、e2e 76 项，树摘要形如 `40533bbf820365ca` |

### 门禁三种情形实测（都是真跑出来的输出）

> 摘要随每次改动变化，下表只是整改过程中的实际输出；同一条命令在别的树上数字会不同。

| 情形 | 结果 | 输出 |
|---|---|---|
| 只跑过 `--fast` 就提交 | **拦下** | `这棵树只跑过 --fast，缺 e2e → 重跑 --full` |
| 验过之后改了 1 个文件 | **拦下** | `验过之后又改了 2 个文件（_dev/issues.bak, issues.md）→ 重跑 --full` |
| 树摘要与绿报告一致 | 放行 | `[通过] 4 项全绿 · 树 40533bbf820365ca（30 个文件）` |

第二行顺带暴露一个真问题：临时备份文件放在 `_dev/` 下也会进摘要——说明「忽略规则」和「待提交内容」是同一条边界，写 `.gitignore` 时要一起想。

还有一处成本要记下来：**改一行文档也要重跑 90 秒的 e2e**，因为摘要按整棵树算。按路径分级豁免（`docs/**` 免 e2e）更省事，但那等于给「绕过」开了口子，暂时不用。先观察一周：如果多数提交是文档，再考虑给 `--full` 加 `--docs-only` 这种显式低配档。

## 3. 为什么门禁是自建的，不是它的

`gate.py --ci` 对一个 29 个文件未提交（含 7 个版本积压）的仓库返回：

```json
{"checks":[{"detail":"no protected path changed","id":"M1","ok":true},
 {"detail":"0 PASS events bound","id":"M2","ok":true},
 {"detail":"no protected path changed","id":"M3","ok":true},
 {"detail":"0 version declaration(s)","id":"M4","ok":true},
 {"detail":"0 snapshots verified","id":"M6","ok":true}],"status":"pass"}
```

三个盲区：

1. **只比 `HEAD~1...HEAD`**（`gate.py` M1/M3 的 `changed_paths`），工作区和暂存区一概看不见。门禁接错了入口，等于没有门禁。
2. **没有证据算通过**：`check_m2` 在 `checked == 0` 时直接 `return True, "0 PASS events bound"`。这与它自己反复强调的 `NOT_RUN != PASS` 正好相反。
3. **只认 `VERSION` 文件或 frontmatter**（M4），看不到 `version.js` 这种自定义单源——本项目 18 个版本的记录它读成 `0 version declaration(s)`。

所以：**方法照抄，工具重写**。`verify.mjs` 只看一件事——磁盘上这棵树有没有跑过全绿，跑过之后有没有再动过。

## 4. 明确不采纳

| 不采纳 | 原因 |
|---|---|
| `specs/` 或 `.agents/SPEC.md` | 会跟 `README.md` / `DEVELOPMENT.md` 形成第二权威。`audit_adoption.py` 只认文件名不认内容，正是这种「文件名权威」的诱因 |
| `.agents/ledger.jsonl`、`artifacts/agent-runs/` | 一个人维护的项目，记账成本高于收益；摘要绑定已经拿到了核心价值 |
| `agent_workflow.py` | 它写 `artifacts/runs/<id>/events.jsonl`，`gate.py` 读 `.agents/ledger.jsonl`，两套字段不通——先接上再谈用 |
| `scaffold_project.py --apply` | `--preview` 只产 12 个文档/schema，不产 `gates/gate.py`、hook、CI，装完仍是「有文档没闸」 |
| 把 `version.js` 换成 `VERSION` | 版本弹窗和 `CHANGELOG.md` 是这个产品的功能，项目事实高于方法默认值 |
| T1 单元测试（暂时） | `public/app.js` 没有模块导出，纯函数抽不出来。先按 `docs/modules.md` 拆出纯逻辑层，再补单测——**顺序反了只会写出一堆测 DOM 的假单测** |

## 5. 后续

- 待办在 `issues.md`：#12（拆出纯逻辑层补 T1）、#13（并发写语义）、#14（视觉断言改计算样式）。
- 按 skill 自己的规则，本次只到 `EVIDENCE_READY`：同类观察累计 ≥2 次才提 proposal，不急着把它升格成项目宪法。
- 换机器或新克隆后，务必执行一次 `git config core.hooksPath .githooks`，否则 `pre-commit` 不生效——**这是本套采纳里唯一「不做就静默失效」的一步**。
