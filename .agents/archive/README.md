# `.agents/archive/` · 退役档案

这里放**已退役但需要留档**的东西。只读，不再更新。

## contracts/ · 手工契约（2026-11-03 ~ 2026-11-04）

一页三段的旧契约：开工前复制 `_template.md`，写完存档。

**2026-11-04 起退役**，新契约改走三 agent 闭环：
`task.md`（Planner）→ `delivery.md`（Worker）→ `verdict.md`（Reviewer），
事件流在 `artifacts/runs/<task_id>/events.jsonl`，由 `.agents/gates/gate.py` 校验。
契约模板见 `.agents/templates/`。

这批文件保留的原因：里面记着当时的决策依据与复核结论，`.agents/issues.md` 有若干条
指向它们当欠债凭证。**整份只读**：第 1/2 段是历史事实，第 3 段复核同样属于历史证据，
不得补写，也不得靠补写把状态改成 `PASS`。状态与事实不符时，在 `issues.md` 登记欠债并注明
「该契约未复核」，不追认。新问题记到 `.agents/issues.md`。
