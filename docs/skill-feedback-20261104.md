# Skill 反馈：ai-native-engineering 完全落实（2026-11-04）

> 记录 Cadence 项目对 `ai-native-engineering` skill 的反馈，供 skill 方参考。
> 分两段：A 是 11-03 选择性采纳时实测的盲区（已推动 skill 3.0.0 修复），
> B 是 11-04 转完全落实过程中新发现的问题。末尾附两条门禁命令的原始输出。

## A. 历史反馈（11-03 实测，已推动 skill 修复）

11-03 首次实测 `gate.py --ci` 时，本仓库有 29 个文件未提交（含 7 个版本积压），
门禁返回的原始输出：

```json
{"checks":[{"detail":"no protected path changed","id":"M1","ok":true},
 {"detail":"0 PASS events bound","id":"M2","ok":true},
 {"detail":"no protected path changed","id":"M3","ok":true},
 {"detail":"0 version declaration(s)","id":"M4","ok":true},
 {"detail":"0 snapshots verified","id":"M6","ok":true}],"status":"pass"}
```

一个「7 个版本没提交、0 条事件流、0 份契约」的仓库被判 `status: pass`，暴露出三个盲区。
这三个盲区当时导致结论是「方法照抄，工具重写」，即选择性采纳。以下逐条记录实测现象与 skill 现在的修复：

### A1. 只比 `HEAD~1...HEAD`

- **当时的实测现象**：M1/M3 的 `changed_paths` 只看 `HEAD~1...HEAD`，工作区和暂存区一概看不见。
  7 个未提交版本里对受保护路径的改动全部不可见，门禁等于没接上要拦的东西。
- **skill 现在的修复**：新增 `--staged` 参数，改判 `git diff --cached`（索引区）。
  pre-commit 用 `gate.py --fast --staged` 拦「已 add 的受保护路径缺契约」，
  未暂存的工作区改动明确不参与判定（当作草稿，进入历史那一刻才拦）。
  本仓库 11-04 实测：`--fast --staged` 能正常跑，索引区为空时提示
  `no staged changes: nothing evaluated` 且不误拦。

### A2. 没有证据算通过

- **当时的实测现象**：`check_m2` 在 `checked == 0` 时直接 `return True, "0 PASS events bound"`。
  0 条事件流判 PASS，与它自己反复强调的 `NOT_RUN != PASS` 正好相反。
- **skill 现在的修复**：无事件流时 M2/M6 返回 `NOT_RUN`，整体状态落到 `no_evidence`，
  CI 模式对 `no_evidence` 退出 1；pre-commit 未建账本时只提示不拦（避免把首次采纳的仓库墙死）。
  本仓库 11-04 实测 `--ci`：M2/M6 均 `NOT_RUN`，`status: no_evidence`，`exit: 1`。

### A3. 只认 `VERSION` 文件

- **当时的实测现象**：M4 只认 `VERSION` 文件或 frontmatter `version:`。
  本项目版本源是 `version.js`（`SEMVER` 常量，18 个版本），被读成 `0 version declaration(s)`。
- **skill 现在的修复**：M4 支持在 `.agents/SPEC.md` 声明 `version_authority: <path>`。
  本项目声明 `version_authority: version.js`，M4 实测 `version authority: version.js`，PASS。
  无需把 `version.js` 换成 `VERSION`（版本弹窗和 CHANGELOG 是本产品的功能，项目事实高于方法默认值）。

## B. 本次完全落实中发现的新问题（11-04）

> 如实记录，没有就写「无」。当前记录两条，都属「采纳成本」，不是 skill 的功能性错误。

### B1. scaffold 对已有文件报 conflict，需要手工调和

本项目在 11-03 已有一份方法层台账（`ai-skills/practice/` 转只读）和已生效的 `AGENTS.md`。
11-04 装执行面时，scaffold 遇到已存在的 `AGENTS.md` / practice 类文件会报冲突，
不能静默合并，最后是手工调和：把「选择性采纳」的旧表述升级为「完全落实」，并让
`.agents/practice/ai-native-engineering.md` 成为唯一活台账（旧台账声明转只读）。

**反馈给 skill**：scaffold 对「目标仓库已有部分采纳痕迹」的升级场景缺少明确的合并指引，
只能靠人判断哪些覆盖、哪些保留、哪些转只读。建议提供「从选择性采纳 → 完全落实」的升级路径说明。

### B2. 执行面与既有 verify.mjs 双轨并存的成本

Cadence 在 11-03 已自建 `_dev/verify.mjs`（语法 + 版本 + CHANGELOG + 服务版本 + e2e 76 项 + 树摘要）。
11-04 接入 `gate.py`（M1-M6 契约门禁）后变成双轨：

- 每次提交前要跑两条门禁（`node _dev/verify.mjs --full` + `python .agents/gates/gate.py --ci`）。
- 两轨管的是两件事（verify 管「代码验过没」，gate 管「流程走完没」），不冲突，但边界要靠人记：
  树摘要分代码/证据/文档三把尺子，gate.py 的 `NOT_RUN`/`no_evidence` 又是另一套状态机，
  新人要读 `AGENTS.md` 第 4/5 节才能分清「哪个红灯该改什么」。

**反馈给 skill**：没有实质 bug，只是「既有项目接入」时双轨的认知成本。若 skill 文档能给出
「已有自建门禁时如何与 gate.py 分工」的对照表，可降低接入摩擦。

## 验证：两条只读门禁命令的原始输出（2026-11-04 实测）

### 命令一：`python .agents/gates/gate.py --ci --repo .`

```
{"base": "HEAD~1", "checks": [{"detail": "no protected path changed", "id": "M1", "ok": true, "state": "PASS"}, {"detail": "no protected path changed", "id": "M3", "ok": true, "state": "PASS"}, {"detail": "NOT_RUN: no event stream under artifacts/runs", "id": "M2", "ok": null, "state": "NOT_RUN"}, {"detail": "version authority: version.js", "id": "M4", "ok": true, "state": "PASS"}, {"detail": "NOT_RUN: no event stream under artifacts/runs", "id": "M6", "ok": null, "state": "NOT_RUN"}, {"detail": "0 dead links", "id": "M5", "ok": true, "state": "PASS"}], "exit": 1, "mode": "ci", "scope": "project", "status": "no_evidence"}
```

退出码：`1`（符合预期：M4 PASS、M2/M6 NOT_RUN、整体 `no_evidence`、exit 1）。

### 命令二：`python .agents/gates/gate.py --fast --staged --repo .`

```
{"base": "HEAD~1", "checks": [{"detail": "no staged changes: nothing evaluated", "id": "M1", "ok": null, "state": "NOT_RUN"}, {"detail": "no staged changes: nothing evaluated", "id": "M3", "ok": null, "state": "NOT_RUN"}], "exit": 0, "ledger_note": "本仓库尚未建立任务账本，本次提交没有评审证据覆盖", "mode": "fast", "note": "only the git index is evaluated; unstaged worktree changes are drafts and are not evaluated (未暂存改动不参与判定)", "scope": "project", "staged": true, "status": "no_evidence"}
```

退出码：`0`（符合预期：能跑，未 add 时索引区为空，`staged` 模式下 `no_evidence` 不拦）。
