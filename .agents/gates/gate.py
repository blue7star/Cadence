"""Deterministic gates M1-M8.

Pre-commit:  python gates/gate.py --fast --staged --repo .
CI:          python gates/gate.py --ci --repo .

`--staged` judges the git index (`git diff --cached`), which is exactly what a
pre-commit hook is about to admit. Without it the hook would only see committed
history and every in-flight change would be invisible. Unstaged worktree edits
are drafts and never block; a protected path that is already staged without a
matching recorded contract is blocked at the moment it would enter history.

Exit codes: 0 = all blocking checks pass, 1 = blocked, 2 = usage/error.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# 受保护面是项目事实，不抄脚手架默认值：路径写在 `.agents/gates/protected.json`，
# 这里只留判定规则。旧默认值 `app/` 与本项目实际代码（server.js / public/）无关，
# 于是「改一行产品代码」从来不会触发 M1——这正是「一句需求就开工」溜过去的那道缝。
PROTECTED_CONFIG = ".agents/gates/protected.json"
FALLBACK_RULES = {
    "files": ("AGENTS.md",),
    "prefixes": ("specs/", "data/"),
    "globs": (),
}

# Runs record the gate rules in force when they were created. Enhanced checks
# (M2 delivery/verdict reconciliation) apply only to RULE_EPOCH and later; older
# runs are reported as legacy and are neither re-judged red nor green. Rule
# upgrades never rewrite old evidence: to re-judge, open a new run.
RULE_EPOCH = 3
GRADE_RANK = {"G0": 0, "G1": 1, "G2": 2, "G3": 3}
RUNS = "artifacts/runs"
EVENTS_FILE = "events.jsonl"
GENESIS_HASH = "0" * 64
EVENT_KEYS = ("seq", "previous_hash", "event_hash", "state", "role", "metadata", "evidence")
VERSION_FILE = "VERSION"
VERSION_AUTHORITY = re.compile(r"^version_authority\s*:\s*(\S+)\s*$", re.MULTILINE)
SPEC_FILE = ".agents/SPEC.md"
FRONTMATTER_VERSION = re.compile(r"^version:\s*(\S+)\s*$", re.MULTILINE)
METHOD_VERSION_LINE = re.compile(r"方法版本\s*[:=：]\s*(\d+\.\d+\.\d+)")
MD_LINK = re.compile(r"\]\(([^)#\s]+)(?:#[^)]*)?\)")
IGNORE_DIRS = (".git", "artifacts", ".agents", "archive", "node_modules", "__pycache__")


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=str(repo), capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def staged_paths(repo: Path) -> list[str]:
    """Paths currently in the index (what the next commit would add)."""
    output = git(repo, "diff", "--cached", "--name-only")
    return [line.strip() for line in output.splitlines() if line.strip()]


def changed_paths(repo: Path, base: str, staged: bool = False) -> list[str]:
    if staged:
        return staged_paths(repo)
    try:
        output = git(repo, "diff", "--name-only", f"{base}...HEAD")
    except RuntimeError:
        output = git(repo, "diff", "--name-only", base, "HEAD")
    return [line.strip() for line in output.splitlines() if line.strip()]


def commit_message(repo: Path) -> str:
    return git(repo, "log", "-1", "--format=%B")


def trailer_value(message: str, key: str) -> str | None:
    match = re.search(rf"^Task:\s*(\S+)\s*$", message, re.MULTILINE) if key == "Task" else None
    return match.group(1) if match else None


def is_protected(path: str, rules: dict[str, tuple[str, ...]] | None = None) -> bool:
    """Case- and separator-insensitive: `Server.js` is the same file as `server.js`.

    Git on Windows is usually case-insensitive (core.ignorecase), so a path that
    differs only in case still writes the same working tree file. Matching it
    literally let that spelling slip past the protected surface (reviewer P3).
    """
    rules = rules or FALLBACK_RULES
    normalised = path.replace("\\", "/").casefold()
    return (
        normalised in {item.replace("\\", "/").casefold() for item in rules["files"]}
        or any(
            normalised.startswith(prefix.replace("\\", "/").casefold())
            for prefix in rules["prefixes"]
        )
        or any(
            fnmatch.fnmatchcase(normalised, pattern.replace("\\", "/").casefold())
            for pattern in rules["globs"]
        )
    )


def protected_rules(repo: Path) -> dict[str, tuple[str, ...]]:
    """Load the project's protected surface.

    Fail closed: a missing config is not "nothing is protected". Deleting it is
    itself a protected change, so a genuine project can always restore it.
    """
    path = repo / PROTECTED_CONFIG
    if not path.is_file():
        raise RuntimeError(
            f"{PROTECTED_CONFIG} 缺失：受保护面是项目事实，缺了就不判定，"
            "恢复该文件后再提交"
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        key: tuple(str(item) for item in data.get(key, ()))
        for key in ("files", "prefixes", "globs")
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_text(text: str) -> dict[str, str]:
    """Collect `key: value` machine fields from anywhere in the document.

    Only snake_case keys count: a contract may start with prose (验收标准) that
    contains colons, and prose must not poison the machine header. Scanning the
    whole file instead of stopping at the first blank line is deliberate — the
    real template keeps 元信息 and 受理 in two blocks, and a gate that only read
    the first one would demand five fields it never sees (reviewer finding P1).
    """
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if line.startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            continue
        key = key.strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) and key not in fields:
            fields[key] = value.split("#")[0].strip()
    return fields


def parse_record(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    return parse_text(path.read_text(encoding="utf-8"))


class LedgerError(Exception):
    """The event stream cannot be trusted, so dependent checks must block."""


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def event_hash(event: dict) -> str:
    unsigned = {key: value for key, value in event.items() if key != "event_hash"}
    return hashlib.sha256(_canonical_bytes(unsigned)).hexdigest()


def run_directories(repo: Path) -> list[Path]:
    base = repo / RUNS
    if not base.is_dir():
        return []
    return sorted(
        path
        for path in base.iterdir()
        if path.is_dir() and (path / EVENTS_FILE).is_file()
    )


def _read_run_events(run_dir: Path) -> list[dict]:
    relative = run_dir.as_posix()
    try:
        lines = (run_dir / EVENTS_FILE).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise LedgerError(f"{relative} is unreadable: {exc}") from exc
    events: list[dict] = []
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LedgerError(f"{relative}:{number} is not valid JSON") from exc
        if not isinstance(event, dict):
            raise LedgerError(f"{relative}:{number} is not an event object")
        events.append(event)
    if not events:
        raise LedgerError(f"{relative} has no events")
    return events


def _verify_chain(relative: str, events: list[dict]) -> None:
    previous_hash = GENESIS_HASH
    for expected_seq, event in enumerate(events, start=1):
        if not set(EVENT_KEYS).issubset(event):
            raise LedgerError(f"{relative} seq {expected_seq} lacks required event fields")
        if event.get("seq") != expected_seq:
            raise LedgerError(f"{relative} seq {expected_seq} is out of order")
        if event.get("previous_hash") != previous_hash:
            raise LedgerError(f"{relative} seq {expected_seq} breaks the previous_hash chain")
        if event.get("event_hash") != event_hash(event):
            raise LedgerError(f"{relative} seq {expected_seq} has a mismatched event_hash")
        if not isinstance(event.get("metadata"), dict):
            raise LedgerError(f"{relative} seq {expected_seq} has no metadata object")
        previous_hash = str(event["event_hash"])


def read_events(repo: Path) -> list[dict]:
    """Adapt the hash-chained event streams into the gate's vocabulary.

    `artifacts/runs/<id>/events.jsonl`, written by `scripts/agent_workflow.py`, is
    the only decision ledger; the gate reads it directly and never produces a
    derived copy. A malformed line, a broken hash chain, or a missing event object
    raises `LedgerError` so dependent checks fail closed rather than pass on an
    empty read.
    """
    adapted: list[dict] = []
    owners: dict[str, str] = {}
    for run_dir in run_directories(repo):
        relative = run_dir.relative_to(repo).as_posix()
        events = _read_run_events(run_dir)
        _verify_chain(relative, events)
        # 一个任务只能有一条事件链。曾经用 `<task_id>-cvN/` 另开一条链来「补契约」，
        # 结果等于绕过状态机重启一次 PLANNED：旧链的 FAIL 还在，新链从零开始又「干净」了。
        # 现在同 task_id 出现第二条链直接判账本损坏，补契约走 bump-contract（同一条链内重写 PLANNED）。
        task_id = str((events[0]["metadata"] or {}).get("task_id") or "")
        if task_id in owners:
            raise LedgerError(
                f"{relative} 与 {owners[task_id]} 声明了同一个任务 {task_id}——"
                "一个任务只允许一条事件链（补契约用 bump-contract，不新开目录）"
            )
        owners[task_id] = relative
        epoch = int((events[0]["metadata"] or {}).get("rule_epoch") or 0)
        for event in events:
            metadata = event["metadata"]
            adapted.append(
                {
                    "run": relative,
                    "task": metadata.get("task_id"),
                    "to": event.get("state"),
                    "role": event.get("role"),
                    "contract_version": metadata.get("contract_version"),
                    "contract_digest": metadata.get("contract_digest"),
                    "candidate_revision": metadata.get("candidate_revision"),
                    "candidate_digest": metadata.get("candidate_digest"),
                    "candidate_snapshot_path": metadata.get("candidate_snapshot_path"),
                    "rule_epoch": epoch,
                }
            )
    return adapted


def task_file(repo: Path, task_id: str) -> Path:
    return repo / RUNS / task_id / "task.md"


def _index_text(repo: Path, relative: str) -> str | None:
    """Return the staged blob of `relative`, or None when it is not in the index."""
    result = subprocess.run(
        ["git", "show", f":{relative}"],
        cwd=str(repo),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout if result.returncode == 0 else None


def _normalized_newlines(text: str) -> str:
    return text.replace("\r\n", "\n")


def _staged_task_matches(repo: Path, task_id: str, recorded_digest: str) -> bool:
    """True when the index version of task.md is still the recorded contract.

    The digest was frozen from the worktree bytes at `init` time. Git may store
    the index blob with normalized line endings (`core.autocrlf=true`), so bytes
    are compared against the worktree and the staged blob is additionally checked
    textually: staged content that differs from the recorded contract is drift
    entering history and must not be admitted.
    """
    relative = f"{RUNS}/{task_id}/task.md"
    worktree = task_file(repo, task_id)
    if not worktree.is_file() or sha256_file(worktree) != recorded_digest:
        return False
    staged = _index_text(repo, relative)
    if staged is None:
        return True
    return _normalized_newlines(staged) == _normalized_newlines(
        worktree.read_text(encoding="utf-8")
    )


def staged_contracts(repo: Path) -> list[tuple[str, dict[str, str]]]:
    """Contracts recorded in the ledger that still match the staged task.md."""
    matches: dict[str, dict[str, str]] = {}
    for event in read_events(repo):
        if event.get("to") != "PLANNED":
            continue
        task_id = event.get("task")
        digest = event.get("contract_digest")
        if not isinstance(task_id, str) or not task_id:
            continue
        if not isinstance(digest, str) or not digest:
            continue
        if task_id in matches or not _staged_task_matches(repo, task_id, digest):
            continue
        matches[task_id] = parse_record(task_file(repo, task_id))
    return sorted(matches.items(), key=lambda item: item[0])


def verdict_file(repo: Path, task_id: str, revision: str) -> Path:
    candidate = repo / RUNS / task_id / f"verdict-a{revision}.md"
    return candidate if candidate.is_file() else repo / RUNS / task_id / "verdict.md"


def delivery_file(repo: Path, task_id: str, revision: str) -> Path:
    candidate = repo / RUNS / task_id / f"delivery-a{revision}.md"
    return candidate if candidate.is_file() else repo / RUNS / task_id / "delivery.md"


DELIVERY_REQUIRED_FIELDS = (
    "contract_version",
    "candidate_revision",
    "candidate_digest",
    "verify_commands",
    "not_run",
)

# Verdict fields are declared once here; templates/verdict.md and tests reference
# this tuple so a new field cannot be added on one side only.
VERDICT_REQUIRED_FIELDS = (
    "task_id",
    "contract_version",
    "candidate_revision",
    "candidate_digest",
    "reviewer",
    "reviewer_context",
    "worker_context",
    "verdict",
    "max_severity",
    "evidence_status",
    "not_run_count",
)
VERDICT_PASS_VALUE = "PASS"
VERDICT_BLOCKING_SEVERITIES = ("P0", "P1")
VERDICT_TOLERATED_SEVERITIES = ("P2", "P3")


MODULE_SEPARATOR = re.compile(r"[,\s]+")
PATHS_LINE = re.compile(r"^paths\s*:\s*(.+)$", re.MULTILINE)


def declared_modules(fields: dict[str, str]) -> set[str]:
    raw = fields.get("modules", "")
    names = set()
    for item in MODULE_SEPARATOR.split(raw):
        name = item.strip("[]").replace("-", "_").casefold()
        if name and not name.startswith("<"):
            names.add(name)
    return names - {"none"}


def _rev_text(repo: Path, rev: str, relative: str) -> str | None:
    result = subprocess.run(
        ["git", "show", f"{rev}:{relative}"],
        cwd=str(repo),
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout if result.returncode == 0 else None


def blueprint_paths(repo: Path, name: str, staged: bool = False) -> list[str]:
    """File ownership declared by the blueprint itself (`paths: a, b/`).

    Ownership used to be guessed from the file name (`server.js` -> module
    `server`), which both missed real modules (`server-api` owns `server.js`)
    and invented false ones. The blueprint now says what it owns.

    The text is read from the index (pre-commit) or from HEAD (CI), not from the
    worktree: otherwise an unstaged blueprint edit would silently widen what a
    contract may touch, and CI would never check ownership at all. A blueprint
    that is in neither place declares nothing — falling back to the worktree let
    an untracked blueprint with `paths: server.js` own any file at the moment it
    was needed (reviewer F3, attempt 2).
    """
    names = (f"{name}.md", f"{name.replace('_', '-')}.md")
    for filename in names:
        relative = f"specs/modules/{filename}"
        text = (
            _index_text(repo, relative) if staged else _rev_text(repo, "HEAD", relative)
        )
        if text is None:
            continue
        match = PATHS_LINE.search(text)
        if not match:
            return []
        raw = match.group(1).split("#")[0]
        items = [item.strip().strip("`") for item in MODULE_SEPARATOR.split(raw) if item.strip()]
        # `paths: *` 一条就能认领整棵受保护面，等于绕过「谁拥有这个文件」的讨论；
        # 蓝图只声明具体文件/目录前缀，通配符一律当没声明（fail closed）。
        return [item for item in items if "*" not in item and "?" not in item]
    return []


def path_covered(pattern: str, path: str) -> bool:
    pattern, path = pattern.casefold(), path.casefold()
    if pattern.endswith("/"):
        return path.startswith(pattern)
    return path == pattern or fnmatch.fnmatchcase(path, pattern)


def module_intersects(
    repo: Path, names: set[str], paths: list[str], staged: bool = False
) -> bool:
    """A contract covers a path when a declared module's blueprint owns it."""
    return any(
        path_covered(pattern, path)
        for name in names
        for pattern in blueprint_paths(repo, name, staged)
        for path in paths
    )


def uncovered_paths(
    repo: Path, names: set[str], paths: list[str], staged: bool = False
) -> list[str]:
    """Touched paths that no declared module owns.

    M1 used to accept a contract as soon as *one* path matched, so declaring
    `app-ui` also let you rewrite `server.js` in the same commit (reviewer P2).
    Every protected path in the change must be owned by something declared.
    """
    patterns = [
        pattern
        for name in names
        for pattern in blueprint_paths(repo, name, staged)
    ]
    return [path for path in paths if not any(path_covered(p, path) for p in patterns)]


def select_staged_contract(
    repo: Path, touched: list[str], task: str | None
) -> tuple[tuple[str, dict[str, str]] | None, str]:
    """The single contract that owns the staged protected change, or why not."""
    contracts = staged_contracts(repo)
    if not contracts:
        return None, (
            f"protected staged change without contract (no matching PLANNED "
            f"contract_digest): {touched[:5]}"
        )
    evaluated = [
        (contract_task, fields, uncovered_paths(repo, declared_modules(fields), touched, True))
        for contract_task, fields in contracts
    ]
    candidates = [
        (contract_task, fields)
        for contract_task, fields, missing in evaluated
        if not missing
    ]
    if task:
        chosen = next((item for item in candidates if item[0] == task), None)
        if chosen is None:
            missing = next(
                (missing for outline, _, missing in evaluated if outline == task), touched
            )
            return None, (
                f"--task {task} does not cover staged protected paths {missing[:5]} "
                "(every protected path must be owned by a declared module)"
            )
        return chosen, ""
    if len(candidates) == 1:
        return candidates[0], ""
    if candidates:
        return None, (
            f"ambiguous staged contract for {touched[:5]}: "
            f"{[item[0] for item in candidates]} (pass --task <task_id>; "
            "the gate does not guess)"
        )
    missing = min((item[2] for item in evaluated), key=len, default=touched)
    return None, (
        f"protected staged change without contract: no declared module owns "
        f"{missing[:5]} (在模块蓝图里补 `paths:` 或修正 modules:)"
    )


def check_m1(
    repo: Path, base: str, staged: bool = False, task: str | None = None
) -> tuple[bool | None, str]:
    paths = changed_paths(repo, base, staged)
    if staged and not paths:
        # An empty index is not a pass: nothing was judged.
        return None, "no staged changes: nothing evaluated"
    rules = protected_rules(repo)
    touched = [path for path in paths if is_protected(path, rules)]
    if not touched:
        # Nothing to admit: this is a complete check, not a skipped one.
        detail = "no protected path changed"
        if staged:
            detail += " (unstaged worktree changes are not evaluated)"
        return True, detail
    if not run_directories(repo):
        # Adoption boundary: before a ledger exists there is no contract to
        # demand. Enforcing here would wall off every first-time project.
        return None, "NOT_RUN: 本仓库尚未采纳任务账本，M1 不执法"
    if staged:
        chosen, reason = select_staged_contract(repo, touched, task)
        if chosen is None:
            return False, reason
        task_id, fields = chosen
        grade = fields.get("gate_level", "")
        if grade not in GRADE_RANK:
            return False, f"task.md has invalid gate_level={grade!r}"
        if GRADE_RANK[grade] == 0:
            return False, f"{task_id} declared G0 but touches contract-face paths: {touched[:5]}"
        return True, f"{task_id} ({grade}) admitted, {len(touched)} protected staged paths"
    task_id = trailer_value(commit_message(repo), "Task")
    if not task_id:
        return False, f"protected change without `Task:` trailer: {touched[:5]}"
    task = task_file(repo, task_id)
    if not task.is_file():
        return False, f"task.md missing for {task_id}"
    fields = parse_record(task)
    grade = fields.get("gate_level", "")
    if grade not in GRADE_RANK:
        return False, f"task.md has invalid gate_level={grade!r}"
    if GRADE_RANK[grade] == 0:
        return False, f"{task_id} declared G0 but touches contract-face paths: {touched[:5]}"
    uncovered = uncovered_paths(repo, declared_modules(fields), touched, staged=False)
    if uncovered:
        return False, (
            f"{task_id} 声明的模块不拥有 {uncovered[:5]}"
            "（每个受保护路径都要有归属；在模块蓝图补 `paths:`）"
        )
    events = read_events(repo)
    planned = [event for event in events if event.get("task") == task_id and event.get("to") == "PLANNED"]
    if not planned:
        return False, f"event stream has no PLANNED event for {task_id}"
    # A contract bump adds a newer run; the highest contract_version is authoritative.
    latest = max(planned, key=lambda event: int(event.get("contract_version") or 0))
    recorded = latest.get("contract_digest")
    if not recorded:
        return False, f"PLANNED event has no contract_digest for {task_id}"
    actual = sha256_file(task)
    if recorded != actual:
        # A contract bump opens a newer run; without it the old digest is a drift.
        return False, (
            f"contract digest mismatch for {task_id} "
            "(改契约后先 bump-contract 开新 run，再继续实现)"
        )
    return True, f"{task_id} ({grade}) admitted, {len(touched)} protected paths"


INTAKE_FIELDS = (
    "requirement_quote",
    "user_problem",
    "out_of_scope",
    "acceptance_command",
    "stop_conditions",
)
# 受理闸生效的 run 代次：旧 run 保持自己的 epoch，不追溯（与 M2 的 RULE_EPOCH 同理）。
INTAKE_EPOCH = 4
# 占位符按「整个值」判定，不做子串匹配：`待办`、`稍后`、`随便` 是本产品的核心用词，
# 而 `requirement_quote` 必须是用户原话——子串匹配会把「待办列表点开就卡」判成占位，
# 守规矩反而无路可走（复核 attempt 5 的 P1）。这里只问：这句话是不是**整句都在说
# 「回头再补」**。是，才拦；只是提到待办两个字，放行。
PLACEHOLDER_TOKENS = {
    "待填", "待补", "待定", "待确认", "待办", "稍后", "稍后补", "回头看", "回头补",
    "回头再补", "回头再说", "以后再补", "以后再说", "再补", "看情况", "暂无", "未定", "随便", "都行",
    "无限制", "没有限制", "不排除任何东西", "不需要停止", "不用停", "不会停",
    "tbd", "todo", "n/a", "na", "-", "--", "none", "null", "—", "–", "……",
}
PLACEHOLDER_WRAPPED = re.compile(r"^(<.*>|…+|\.{3,})$")
PLACEHOLDER_SEGMENT = re.compile(r"[\s，,。；;、/|]+")
# 括号补注先整段摘掉：`TBD（待补）`、`待办（回头再补）` 摘完就回到占位词本身。
PLACEHOLDER_PARENS = re.compile(r"[（(【\[《<][^）)】\]》>]*[）)】\]》>]")
# 占位词后面常跟语气词或补注，`以后再补吧` / `待定一下` / `暂无内容` 与裸占位词同义。
# 只从两端剥离，且每剥一步都重新比对词表：剥完正好等于占位词才算占位；
# `待办列表点开就卡` 剥不动（尾部是「卡」），照旧放行。
PLACEHOLDER_FILLERS = (
    "一点点", "一下", "一点", "内容", "东西", "事项", "信息", "暂时", "先", "再",
    "吧", "呢", "啊", "了", "呀", "哦", "嘛", "啦", "呗", "嗯", "哈", "的",
)
# 语气词只归一了一半：标点还挂在那儿，`以后再补…` / `以后再补吧～` 就还是另一个字符串。
# 比对前把两端的非文字字符全剥掉（汉字、字母、数字以外），剥成空段说明这段只有标点，
# 同样不承载内容。复核 attempt 7 的 F1 就差这一步归一。
PLACEHOLDER_EDGE = re.compile(r"^[^0-9A-Za-z\u4e00-\u9fa5]+|[^0-9A-Za-z\u4e00-\u9fa5]+$")


def _placeholder_after_filler(part: str) -> bool:
    pending = [part]
    seen: set[str] = set()
    while pending:
        current = PLACEHOLDER_EDGE.sub("", pending.pop())
        if not current:
            return True
        if current in seen:
            continue
        seen.add(current)
        if current.casefold() in PLACEHOLDER_TOKENS:
            return True
        for word in PLACEHOLDER_FILLERS:
            if current.startswith(word) and len(current) > len(word):
                pending.append(current[len(word):])
            if current.endswith(word) and len(current) > len(word):
                pending.append(current[: -len(word)])
    return False


def is_placeholder(value: str) -> bool:
    stripped = value.strip().strip("。.!！?？；;，, ")
    if not stripped or PLACEHOLDER_WRAPPED.match(stripped):
        return True
    stripped = PLACEHOLDER_PARENS.sub("", stripped).strip()
    if not stripped:
        return True
    if stripped.casefold() in PLACEHOLDER_TOKENS:
        return True
    segments = [part for part in PLACEHOLDER_SEGMENT.split(stripped) if part]
    return bool(segments) and all(_placeholder_after_filler(part) for part in segments)


# 判定只做三件事：字段在不在、是不是占位符、两个客观形状对不对。
# 刻意不做语义分类——「范围限于工具」「先与用户确认」都是正常答法，关键词判词会误杀，
# 误杀的摩擦最后会把人逼到 --no-verify。长度只挡「没写」。
INTAKE_MIN_SUBSTANCE = {
    "requirement_quote": 6,
    "user_problem": 8,
    "out_of_scope": 4,
    "acceptance_command": 8,
    "stop_conditions": 4,
}
QUOTE_MARK = re.compile(r"[「『\"'“”‘’`]")
COMMAND_SHAPE = re.compile(
    r"(python3?|node|npm|npx|git|pwsh|powershell|bash|\./|\.\\)"
    r"|\b[A-Za-z0-9_./-]+\.(mjs|js|py|bat|cmd|sh)\b",
    re.IGNORECASE,
)
EXPECTED_RESULT = re.compile(
    r"(退出码|exit\s*code|exit=|\bexit\s+\d|返回\s*0|期望\s*0|期望.*(通过|成功))",
    re.IGNORECASE,
)
SUBSTANCE = re.compile(r"[\u4e00-\u9fa5A-Za-z0-9]")


def contract_epoch(repo: Path, task_id: str) -> int:
    epochs = [
        int(event.get("rule_epoch") or 0)
        for event in read_events(repo)
        if event.get("task") == task_id and event.get("to") == "PLANNED"
    ]
    return max(epochs) if epochs else 0


def intake_problems(fields: dict[str, str]) -> list[str]:
    problems: list[str] = []
    for name in INTAKE_FIELDS:
        value = (fields.get(name) or "").strip()
        if not value:
            problems.append(f"{name} 缺失")
            continue
        if is_placeholder(value):
            problems.append(f"{name} 仍是占位符 {value!r}")
            continue
        if len(SUBSTANCE.findall(value)) < INTAKE_MIN_SUBSTANCE[name]:
            problems.append(f"{name} 没有实质内容 {value!r}")
            continue
        if name == "requirement_quote" and not QUOTE_MARK.search(value):
            problems.append(f"{name} 必须引用用户原话（带引号）{value!r}")
            continue
        if name == "acceptance_command" and not (
            COMMAND_SHAPE.search(value) and EXPECTED_RESULT.search(value)
        ):
            problems.append(f"{name} 必须是一条可执行命令 + 期望结果 {value!r}")
    return problems


def check_m8(
    repo: Path, base: str, staged: bool = False, task: str | None = None
) -> tuple[bool | None, str]:
    """受理闸：一句话可以开工，但五个字段必须先写清。

    用户原话 / 真实场景 / 不做什么 / 验收命令 / 停条件——缺一项或写占位符
    就 BLOCKED。它拦的不是「一句话需求」，而是「一句话之后什么都没问就动手」。
    """
    paths = changed_paths(repo, base, staged)
    if staged and not paths:
        return None, "no staged changes: nothing evaluated"
    touched = [path for path in paths if is_protected(path, protected_rules(repo))]
    if not touched:
        return True, "no protected path changed"
    if not run_directories(repo):
        return None, "NOT_RUN: 本仓库尚未采纳任务账本"
    if staged:
        chosen, reason = select_staged_contract(repo, touched, task)
        if chosen is None:
            return None, f"NOT_RUN: 没有可判定的契约（M1 已阻断：{reason}）"
        task_id, fields = chosen
    else:
        task_id = trailer_value(commit_message(repo), "Task")
        if not task_id:
            return None, "NOT_RUN: 提交信息没有 `Task:` trailer（M1 已阻断）"
        fields = parse_record(task_file(repo, task_id))
    epoch = contract_epoch(repo, task_id)
    if epoch < INTAKE_EPOCH:
        return None, (
            f"NOT_RUN: {task_id} 建于 rule_epoch {epoch} < {INTAKE_EPOCH}；"
            "规则升级不追溯旧契约"
        )
    problems = intake_problems(fields)
    if problems:
        return False, (
            f"{task_id} 受理信息不完整：{'；'.join(problems)}"
            "（先写清用户原话 / 真实场景 / 不做什么 / 怎么算成 / 何时停，再开工）"
        )
    return True, f"{task_id} 受理五字段齐备"


def check_m2(repo: Path) -> tuple[bool | None, str]:
    events = read_events(repo)
    if not events:
        return None, "NOT_RUN: no event stream under artifacts/runs"
    passes = [event for event in events if event.get("to") == "PASS"]
    if not passes:
        return None, f"NOT_RUN: 0 PASS events in {len(events)} recorded event(s)"
    current = [event for event in passes if event.get("rule_epoch", 0) >= RULE_EPOCH]
    legacy = len(passes) - len(current)
    if not current:
        return None, (
            f"NOT_RUN: {legacy} PASS event(s) are legacy (rule_epoch<{RULE_EPOCH}); "
            "rule upgrades do not re-judge old evidence"
        )
    checked = 0
    for event in current:
        task_id = event.get("task", "")
        revision = str(event.get("candidate_revision", "1"))
        path = verdict_file(repo, task_id, revision)
        if not path.is_file():
            return False, f"PASS without verdict.md: {task_id}"
        fields = parse_record(path)
        missing = [name for name in VERDICT_REQUIRED_FIELDS if not fields.get(name)]
        if missing:
            return False, (
                f"verdict.md missing field(s) {', '.join(missing)}: {task_id} "
                f"({path.relative_to(repo).as_posix()})"
            )
        if fields["verdict"] != VERDICT_PASS_VALUE:
            return False, (
                f"verdict says {fields['verdict']} while ledger says PASS: {task_id}"
            )
        if fields["evidence_status"] == "NOT_RUN":
            return False, f"evidence_status=NOT_RUN cannot back a PASS: {task_id}"
        try:
            not_run_count = int(fields["not_run_count"])
        except ValueError:
            return False, (
                f"not_run_count={fields['not_run_count']} is not an integer: {task_id}"
            )
        if not_run_count != 0:
            return False, f"not_run_count={not_run_count} must be 0 for PASS: {task_id}"
        severity = fields["max_severity"]
        if severity in VERDICT_BLOCKING_SEVERITIES:
            return False, (
                f"max_severity={severity} blocks PASS "
                f"(P0/P1 must be fixed before acceptance): {task_id}"
            )
        if severity in VERDICT_TOLERATED_SEVERITIES:
            findings_text = path.read_text(encoding="utf-8")
            if not re.search(rf"\|[^|\n]*\|\s*{severity}\s*\|", findings_text):
                return False, (
                    f"max_severity={severity} must appear as a Findings row: {task_id}"
                )
        if severity not in (
            ("NONE",) + VERDICT_BLOCKING_SEVERITIES + VERDICT_TOLERATED_SEVERITIES
        ):
            return False, f"max_severity={severity} is not a known level: {task_id}"
        if fields.get("candidate_digest") != event.get("candidate_digest"):
            return False, f"verdict digest != ledger digest: {task_id}"
        if fields.get("reviewer_context") and fields.get("worker_context"):
            if fields["reviewer_context"] == fields["worker_context"]:
                return False, f"reviewer context equals worker context: {task_id}"
        delivery = delivery_file(repo, task_id, revision)
        if not delivery.is_file():
            return False, (
                f"PASS without delivery.md: {task_id} "
                f"(expected {RUNS}/{task_id}/delivery-a{revision}.md or delivery.md)"
            )
        delivered = parse_record(delivery)
        missing = [name for name in DELIVERY_REQUIRED_FIELDS if not delivered.get(name)]
        if missing:
            return False, (
                f"delivery.md missing field(s) {', '.join(missing)}: {task_id} "
                f"({delivery.relative_to(repo).as_posix()})"
            )
        if delivered["candidate_digest"] != event.get("candidate_digest"):
            return False, (
                f"delivery candidate_digest != ledger digest: {task_id} "
                f"(delivery={delivered['candidate_digest'][:12]}..., "
                f"ledger={str(event.get('candidate_digest'))[:12]}...)"
            )
        if str(delivered["candidate_revision"]) != revision:
            return False, (
                f"delivery candidate_revision={delivered['candidate_revision']} "
                f"!= ledger revision={revision}: {task_id}"
            )
        # delivery.not_run and verdict.not_run_count must describe the same list;
        # otherwise "not_run_count: 0" silently covers checks that never ran.
        declared_not_run = [
            item.strip() for item in delivered["not_run"].split(";") if item.strip()
        ]
        if declared_not_run == ["none"]:
            declared_not_run = []
        if len(declared_not_run) != not_run_count:
            return False, (
                f"delivery not_run lists {len(declared_not_run)} item(s) "
                f"but verdict not_run_count={not_run_count}: {task_id}"
            )
        checked += 1
    suffix = f" (legacy skipped: {legacy})" if legacy else ""
    return True, f"{checked} PASS events bound{suffix}"


def legacy_run_count(repo: Path) -> int:
    """Runs created before the current rule epoch: reported, never re-judged."""
    count = 0
    for run_dir in run_directories(repo):
        events = _read_run_events(run_dir)
        planned = [event for event in events if event.get("state") == "PLANNED"]
        epoch = int((planned[0].get("metadata") or {}).get("rule_epoch") or 0) if planned else 0
        if epoch < RULE_EPOCH:
            count += 1
    return count


def check_m3(
    repo: Path, base: str, staged: bool = False, task: str | None = None
) -> tuple[bool | None, str]:
    paths = changed_paths(repo, base, staged)
    if staged and not paths:
        return None, "no staged changes: nothing evaluated"
    touched = [path for path in paths if is_protected(path, protected_rules(repo))]
    if not touched:
        detail = "no protected path changed"
        if staged:
            detail += " (unstaged worktree changes are not evaluated)"
        return True, detail
    if staged:
        contracts = staged_contracts(repo)
        if not contracts:
            return None, "NOT_RUN: 暂存区没有与 task.md 匹配的 PLANNED 契约，M3 无从校验"
        # 暂存时可能同时有多份契约覆盖受保护路径（比如门槛改动前后各一份）。
        # 以前这里闷头取 contracts[0]，于是 --task 指的那份没被查，pre-commit 绿、CI 红。
        # 现在跟 M1 一个口径：有 --task 就用它，只有一份就自动，多份就明说不猜。
        if task:
            chosen = next((item for item in contracts if item[0] == task), None)
            if chosen is None:
                return False, f"--task {task} 没有匹配的暂存契约（M1 应已拦下）"
            task_id, fields = chosen
        elif len(contracts) == 1:
            task_id, fields = contracts[0]
        else:
            return False, (
                f"暂存区有多份匹配契约 {[item[0] for item in contracts]}，M3 不猜——用 --task 指定"
            )
    else:
        task_id = trailer_value(commit_message(repo), "Task")
        if not task_id:
            return None, "NOT_RUN: 提交信息没有 `Task:` trailer，M3 无从校验"
        fields = parse_record(task_file(repo, task_id))
    if fields.get("blueprint_impact") == "none":
        return True, "blueprint_impact: none (assertion checked by M2)"
    modules = [item.strip() for item in fields.get("modules", "").strip("[]").split(",")]
    modules = [item for item in modules if item and item != "none"]
    if not modules:
        return None, "NOT_RUN: task.md 未声明 modules，M3 无从校验"
    for module in modules:
        blueprint = repo / "specs" / "modules" / f"{module}.md"
        if not blueprint.is_file():
            # modules were declared: the blueprint is promised, its absence is a defect.
            return False, (
                f"module blueprint missing: {module} "
                f"(create specs/modules/{module}.md from specs/modules/_template.md)"
            )
        if task_id not in blueprint.read_text(encoding="utf-8"):
            return False, f"blueprint {module} has no change-history row for {task_id}"
    return True, f"{len(modules)} blueprints updated"


def version_declarations(repo: Path) -> list[tuple[str, str]]:
    declarations: list[tuple[str, str]] = []
    version_file = repo / VERSION_FILE
    if version_file.is_file() and version_file.read_text(encoding="utf-8").strip():
        declarations.append((VERSION_FILE, version_file.read_text(encoding="utf-8").strip()))
    for path in repo.rglob("*.md"):
        relative = path.relative_to(repo).as_posix()
        if any(part in relative for part in IGNORE_DIRS):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        head = "\n".join(text.splitlines()[:12])
        match = FRONTMATTER_VERSION.search(head) or METHOD_VERSION_LINE.search(text)
        if match:
            declarations.append((relative, match.group(1)))
    return declarations


def version_authority(repo: Path) -> str | None:
    """The single version source a project declares in `.agents/SPEC.md`."""
    spec = repo / SPEC_FILE
    if not spec.is_file():
        return None
    match = VERSION_AUTHORITY.search(spec.read_text(encoding="utf-8", errors="ignore"))
    return match.group(1) if match else None


def check_m4(repo: Path, scope: str = "project") -> tuple[bool | None, str]:
    declarations = version_declarations(repo)
    if scope == "suite":
        if len(declarations) == 0:
            return False, "0 version declaration(s): suite repo requires exactly 1"
        if len(declarations) > 1:
            names = [item[0] for item in declarations]
            return False, (
                f"{len(declarations)} version declaration(s): suite repo requires "
                f"exactly 1, found {names}"
            )
        return True, f"1 version declaration (suite): {declarations[0][0]} = {declarations[0][1]}"
    authority = version_authority(repo)
    if not authority:
        return None, (
            "NOT_RUN: 项目未声明版本权威"
            f"（在 {SPEC_FILE} 写 `version_authority: <path>`；"
            "若项目无版本概念，写 `version_authority: none`）"
        )
    if authority == "none":
        return True, "项目声明无版本概念（version_authority: none）"
    if not (repo / authority).is_file():
        return False, f"version_authority target missing: {authority}"
    for document in (SPEC_FILE, "AGENTS.md"):
        path = repo / document
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        head = "\n".join(text.splitlines()[:12])
        if FRONTMATTER_VERSION.search(head):
            return False, (
                f"second version declaration in {document}: version authority is {authority}"
            )
    return True, f"version authority: {authority}"


def check_m5(repo: Path) -> tuple[bool, str]:
    dead: list[str] = []
    for path in repo.rglob("*.md"):
        relative = path.relative_to(repo).as_posix()
        if any(part in relative for part in IGNORE_DIRS):
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for target in MD_LINK.findall(text):
            if target.startswith(("http://", "https://", "mailto:", "app://")):
                continue
            if not (path.parent / target).exists() and not (repo / target).exists():
                dead.append(f"{relative} -> {target}")
    return True, f"{len(dead)} dead links" + (f": {dead[:5]}" if dead else "")


def check_m6(repo: Path) -> tuple[bool | None, str]:
    events = read_events(repo)
    if not events:
        return None, "NOT_RUN: no event stream under artifacts/runs"
    bound = [event for event in events if event.get("candidate_digest")]
    if not bound:
        return None, "NOT_RUN: no sealed candidate in event stream"
    seen: dict[str, str] = {}
    verified = 0
    for event in bound:
        task_id = event.get("task", "")
        digest = event.get("candidate_digest")
        revision = str(event.get("candidate_revision", "1"))
        key = f"{task_id}:{revision}"
        if digest in seen.values() and seen.get(key) != digest:
            previous = [name for name, value in seen.items() if value == digest and name != key]
            if previous:
                return False, f"candidate digest reused within {task_id} (A->B->A)"
        seen[key] = digest
        snapshot = event.get("candidate_snapshot_path")
        if not snapshot:
            return False, f"sealed candidate without snapshot path: {task_id}"
        target = repo / snapshot
        if not target.is_file():
            return False, f"snapshot missing: {snapshot}"
        if sha256_file(target) != digest:
            return False, f"snapshot bytes != recorded digest: {snapshot}"
        verified += 1
    return True, f"{verified} snapshots verified"


SUITE_NA_REASON = (
    "方法论仓库自身不产生 agent run 事件流；套件自身的证据是 "
    "validate_suite + evals + pytest"
)
SUITE_NA_CHECKS = ("M2", "M6")


def run(args: argparse.Namespace) -> dict:
    repo = Path(args.repo).resolve()
    if not (repo / ".git").exists():
        return {"status": "error", "error_code": "not_a_git_repository", "repo": str(repo)}
    scope = getattr(args, "scope", "project")
    staged = bool(getattr(args, "staged", False))
    base = args.base or os.environ.get("GATE_BASE") or "HEAD~1"
    checks: list[dict] = []
    plan = [
        ("M1", lambda: check_m1(repo, base, staged, getattr(args, "task", None))),
        ("M8", lambda: check_m8(repo, base, staged, getattr(args, "task", None))),
        ("M3", lambda: check_m3(repo, base, staged, getattr(args, "task", None))),
    ]
    if args.ci:
        plan += [("M2", lambda: check_m2(repo)), ("M4", lambda: check_m4(repo, scope)), ("M6", lambda: check_m6(repo))]
        plan += [("M5", lambda: check_m5(repo))]
    for name, fn in plan:
        try:
            ok, detail = fn()
        except LedgerError as exc:
            ok, detail = False, f"ledger error: {exc}"
        except Exception as exc:  # boundary: machine-readable failure
            ok, detail = False, f"internal error: {exc}"
        state = "PASS" if ok is True else ("NOT_RUN" if ok is None else "BLOCKED")
        if state == "NOT_RUN" and scope == "suite" and name in SUITE_NA_CHECKS:
            state = "NOT_APPLICABLE"
            detail = f"NOT_APPLICABLE: {SUITE_NA_REASON} (underlying: {detail})"
        checks.append({"id": name, "ok": ok, "state": state, "detail": detail})
    # M5 is advisory: it never blocks, and it never decides the overall status.
    decisive = [item for item in checks if item["id"] != "M5"]
    if any(item["state"] == "BLOCKED" for item in decisive):
        status = "blocked"
    elif any(item["state"] == "NOT_RUN" for item in decisive):
        status = "no_evidence"
    elif any(item["state"] == "NOT_APPLICABLE" for item in decisive):
        status = "pass_with_na"
    else:
        status = "pass"
    payload = {
        "status": status,
        "scope": scope,
        "mode": "ci" if args.ci else "fast",
        "base": base,
        "checks": checks,
    }
    if staged:
        payload["staged"] = True
        payload["note"] = (
            "only the git index is evaluated; unstaged worktree changes are "
            "drafts and are not evaluated (未暂存改动不参与判定)"
        )
        if not run_directories(repo):
            payload["ledger_note"] = "本仓库尚未建立任务账本，本次提交没有评审证据覆盖"
    if run_directories(repo):
        try:
            payload["legacy"] = legacy_run_count(repo)
        except LedgerError:
            payload["legacy"] = 0
    return payload


SELFTEST_TASK = "TASK-SELFTEST-gate"
SELFTEST_FIELDS = {
    "requirement_quote": "用户说「改一行代码也要先有契约」",
    "user_problem": "改 server.js 时门禁不亮，一句话需求可以直接开工",
    "out_of_scope": "不接 M9 契约先行；不改产品行为",
    "acceptance_command": "python .agents/gates/gate.py --fast --staged --repo . 期望退出码 0",
    "stop_conditions": "发现必须改产品行为才能继续时停下上报",
}


def _selftest_git(repo: Path, *args: str) -> None:
    result = subprocess.run(
        ["git", *args], cwd=str(repo), capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode != 0:
        raise RuntimeError(f"selftest git {' '.join(args)} failed: {result.stderr.strip()}")


def _selftest_events(repo: Path, task_id: str, digest: str, epoch: int) -> None:
    event = {
        "seq": 1,
        "previous_hash": GENESIS_HASH,
        "event_hash": "",
        "state": "PLANNED",
        "role": "Planner",
        "metadata": {
            "task_id": task_id,
            "contract_version": 1,
            "base_revision": "selftest-base",
            "rule_epoch": epoch,
            "contract_digest": digest,
        },
        "evidence": {},
    }
    event["event_hash"] = event_hash(event)
    (repo / RUNS / task_id / EVENTS_FILE).write_text(
        json.dumps(event, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def _selftest_contract(
    repo: Path,
    task_id: str,
    modules: str = "server-api",
    epoch: int = 4,
    fields: dict[str, str] | None = None,
    keep_digest: bool = False,
    sections: bool = False,
) -> None:
    values = dict(SELFTEST_FIELDS if epoch >= INTAKE_EPOCH else {})
    values.update({"task_id": task_id, "contract_version": "1", "gate_level": "G2",
                   "status": "PLANNED", "modules": modules, "blueprint_impact": "none"})
    values.update(fields or {})
    task = repo / RUNS / task_id / "task.md"
    task.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for key, value in values.items():
        if sections and key == INTAKE_FIELDS[0]:
            lines.extend(["", "## 受理", ""])
        lines.append(f"{key}: {value}")
    task.write_text("\n".join(lines) + "\n", encoding="utf-8")
    digest = sha256_file(task)
    if keep_digest:
        recorded = json.loads((repo / RUNS / task_id / EVENTS_FILE).read_text(encoding="utf-8"))
        digest = recorded["metadata"]["contract_digest"]
    _selftest_events(repo, task_id, digest, epoch)


def _selftest_repo(
    root: Path,
    modules: str = "server-api",
    epoch: int = 4,
    fields: dict[str, str] | None = None,
    sections: bool = False,
) -> None:
    (root / ".agents" / "gates").mkdir(parents=True)
    shutil.copy(
        Path(__file__).resolve().parent / "protected.json",
        root / ".agents" / "gates" / "protected.json",
    )
    module_dir = root / "specs" / "modules"
    module_dir.mkdir(parents=True)
    (module_dir / "server-api.md").write_text(
        "# MOD-server-api\n\npaths: server.js\n\n## 变更历史\n"
        f"| task_id |\n|---|\n| {SELFTEST_TASK} |\n",
        encoding="utf-8",
    )
    (module_dir / "server.md").write_text(
        "# MOD-server\n\npaths: version.js\n", encoding="utf-8"
    )
    (module_dir / "app-ui.md").write_text(
        "# MOD-app-ui\n\npaths: public/\n", encoding="utf-8"
    )
    (root / "public").mkdir()
    (root / "public" / "app.js").write_text("// ui\n", encoding="utf-8")
    (root / "server.js").write_text("// v1\n", encoding="utf-8")
    _selftest_contract(
        root, SELFTEST_TASK, modules=modules, epoch=epoch, fields=fields, sections=sections
    )
    _selftest_git(root, "init", "-q", "-b", "main")
    _selftest_git(root, "config", "user.email", "selftest@example.invalid")
    _selftest_git(root, "config", "user.name", "selftest")
    _selftest_git(root, "add", ".")
    _selftest_git(root, "commit", "-q", "-m", "selftest base")


def _selftest_run(root: Path) -> tuple[int, dict[str, dict]]:
    (root / "server.js").write_text("// v2\n", encoding="utf-8")
    _selftest_git(root, "add", "server.js")
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--fast", "--staged",
         "--repo", str(root)],
        capture_output=True, text=True, encoding="utf-8",
    )
    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        payload = {}
    return result.returncode, {item["id"]: item for item in payload.get("checks", [])}


def run_selftest() -> int:
    """用临时仓库把 M1/M8 的拦与不拦都跑一遍。

    门禁自己也需要反例：只宣称「会拦」没有意义，要有一条命令能证明它真的红过。
    每个用例都是独立临时仓库，不动当前工作区。
    """
    def expect(name, case):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            problem = ""
            try:
                verify = case(root)
                code, checks = _selftest_run(root)
                problem = verify(root, code, checks)
            except Exception as exc:  # selftest must report, not explode
                problem = f"用例执行出错：{exc}"
        if problem:
            print(f"[失败] {name}：{problem}")
            return 1
        print(f"[通过] {name}")
        return 0

    def cases():
        def admitted(root):
            _selftest_repo(root)

            def verify(_root, code, checks):
                if code != 0:
                    return f"期望放行，实际退出 {code}：{checks.get('M1', {}).get('detail')}"
                if checks.get("M1", {}).get("state") != "PASS":
                    return f"M1 应 PASS，实际 {checks.get('M1')}"
                if checks.get("M8", {}).get("state") != "PASS":
                    return f"M8 应 PASS，实际 {checks.get('M8')}"
                return ""
            return verify

        def drifted(root):
            _selftest_repo(root)
            _selftest_contract(root, SELFTEST_TASK, fields={"stop_conditions": "改了但没同步账本"},
                               keep_digest=True)

            def verify(_root, code, checks):
                if code == 0 or checks.get("M1", {}).get("state") != "BLOCKED":
                    return f"契约摘要漂移应被 M1 拦，实际 {checks.get('M1')}"
                return ""
            return verify

        def missing_field(root):
            _selftest_repo(root, fields={"stop_conditions": ""})

            def verify(_root, code, checks):
                if checks.get("M1", {}).get("state") != "PASS":
                    return f"本用例只想验证 M8，M1 却先红了：{checks.get('M1')}"
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"停条件为空应被 M8 拦，实际 {checks.get('M8')}"
                return ""
            return verify

        def placeholder(root):
            _selftest_repo(root, fields={"out_of_scope": "<待填>"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"占位符应被 M8 拦，实际 {checks.get('M8')}"
                return ""
            return verify

        def stem_guess(root):
            _selftest_repo(root, modules="server")

            def verify(_root, code, checks):
                if code == 0 or checks.get("M1", {}).get("state") != "BLOCKED":
                    return f"模块不拥有 server.js 时应拦（不再按文件名猜），实际 {checks.get('M1')}"
                return ""
            return verify

        def sectioned(root):
            # 真实模板把受理字段放在第二个小节里；门禁只读第一段的实现曾在这里全绿（P1）。
            _selftest_repo(root, sections=True)

            def verify(_root, code, checks):
                if code != 0:
                    return f"受理字段写在第二个小节时应能读到，实际退出 {code}：{checks.get('M8')}"
                if checks.get("M8", {}).get("state") != "PASS":
                    return f"跨小节读取失败：{checks.get('M8')}"
                return ""
            return verify

        def partial_cover(root):
            # 只声明 app-ui（paths: public/），却改了 server.js —— 旧实现判「有交集」就放行。
            _selftest_repo(root, modules="app-ui")

            def verify(_root, code, checks):
                if code == 0 or checks.get("M1", {}).get("state") != "BLOCKED":
                    return f"未覆盖的受保护路径应拦，实际 {checks.get('M1')}"
                return ""
            return verify

        def weak_placeholder(root):
            _selftest_repo(root, fields={"out_of_scope": "TBD 稍后补"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"「TBD 稍后补」也应算占位符，实际 {checks.get('M8')}"
                return ""
            return verify

        def placeholder_variants(root):
            # 复核 attempt 2 的 F2：「待定，回头再补」「N/A」都能溜过上一版正则。
            _selftest_repo(root, fields={"out_of_scope": "待定，回头再补"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"「待定，回头再补」应算占位符，实际 {checks.get('M8')}"
                return ""
            return verify

        def untracked_blueprint(root):
            # F3：蓝图不在索引/HEAD 时旧实现回退读工作区，于是临时写一份就能扩权。
            _selftest_repo(root, modules="ops", epoch=4)
            blueprint = root / "specs" / "modules" / "ops.md"
            blueprint.parent.mkdir(parents=True, exist_ok=True)
            blueprint.write_text("# MOD-ops\n\npaths: server.js\n", encoding="utf-8")

            def verify(_root, code, checks):
                if code == 0 or checks.get("M1", {}).get("state") != "BLOCKED":
                    return f"未跟踪的蓝图不应扩权，实际 {checks.get('M1')}"
                return ""
            return verify

        def scope_word_salad(root):
            # 复核 attempt 3：词表列的「以后再补」不算占位符，但「不做什么」必须含排除词。
            _selftest_repo(root, fields={"out_of_scope": "以后再补"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"「以后再补」应被形状规则拦下，实际 {checks.get('M8')}"
                return ""
            return verify

        def command_shape(root):
            # 验收命令必须像命令，并写明期望结果。
            _selftest_repo(root, fields={"acceptance_command": "python .agents/selftest.py 看看"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"没有期望结果的命令应拦，实际 {checks.get('M8')}"
                return ""
            return verify

        def quote_required(root):
            # 「用户原话」必须真的是引用。
            _selftest_repo(root, fields={"requirement_quote": "用户要求引入门禁系统"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"没有引号的原话应拦，实际 {checks.get('M8')}"
                return ""
            return verify

        def wildcard_blueprint(root):
            # `paths: *` 等于认领整棵树，必须当没声明。
            _selftest_repo(root)
            (root / "specs" / "modules" / "server-api.md").write_text(
                "# MOD-server-api\n\npaths: *\n", encoding="utf-8"
            )
            _selftest_git(root, "add", "specs/modules/server-api.md")

            def verify(_root, code, checks):
                if code == 0 or checks.get("M1", {}).get("state") != "BLOCKED":
                    return f"通配符蓝图不应认领 server.js，实际 {checks.get('M1')}"
                return ""
            return verify

        def positive_scope_phrasing(root):
            # 复核 attempt 4：正常的「不做什么」写法不许被关键词规则误杀。
            _selftest_repo(root, fields={"out_of_scope": "本次范围限于工具与文档，M9 留待后续"})

            def verify(_root, code, checks):
                if code != 0 or checks.get("M8", {}).get("state") != "PASS":
                    return f"正常范围描述应放行，实际 {checks.get('M8')}"
                return ""
            return verify

        def positive_stop_phrasing(root):
            _selftest_repo(root, fields={"stop_conditions": "需要改动产品行为或数据模型时，先与用户确认再继续"})

            def verify(_root, code, checks):
                if code != 0 or checks.get("M8", {}).get("state") != "PASS":
                    return f"正常停条件应放行，实际 {checks.get('M8')}"
                return ""
            return verify

        def positive_stop_short(root):
            _selftest_repo(root, fields={"stop_conditions": "口径不清时与用户确认"})

            def verify(_root, code, checks):
                if code != 0 or checks.get("M8", {}).get("state") != "PASS":
                    return f"带「确认」的停条件应放行，实际 {checks.get('M8')}"
                return ""
            return verify

        def non_answer_scope(root):
            # 「不排除任何东西」是句子但不是答案：占位筛子要挡。
            _selftest_repo(root, fields={"out_of_scope": "不排除任何东西"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"「不排除任何东西」应算占位，实际 {checks.get('M8')}"
                return ""
            return verify

        def non_answer_stop(root):
            _selftest_repo(root, fields={"stop_conditions": "不需要停止"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"「不需要停止」应算占位，实际 {checks.get('M8')}"
                return ""
            return verify

        def todo_word_in_quote(root):
            # 复核 attempt 5：`待办` 是产品核心用词，出现在用户原话里不能算占位。
            _selftest_repo(
                root,
                fields={"requirement_quote": "用户说「待办列表点开就卡，先修这个」"},
            )

            def verify(_root, code, checks):
                if code != 0 or checks.get("M8", {}).get("state") != "PASS":
                    return f"含「待办」二字的正常原话应放行，实际 {checks.get('M8')}"
                return ""
            return verify

        def later_word_in_stop(root):
            _selftest_repo(
                root,
                fields={"stop_conditions": "稍后发现数据不对就立即停止并上报"},
            )

            def verify(_root, code, checks):
                if code != 0 or checks.get("M8", {}).get("state") != "PASS":
                    return f"含「稍后」二字的正常停条件应放行，实际 {checks.get('M8')}"
                return ""
            return verify

        def placeholder_equivalence_class(root):
            # 复核 attempt 6 的 F1：整值完全相等后，加个语气词或一层括号就绕过。
            # 这里直接断言判定函数：占位词的「等价类」（+语气词/+括号补注）都要拦，
            # 而提到待办/稍后/先停这类正常写法仍要放行。
            _selftest_repo(root)
            must_block = [
                "以后再补吧", "回头再补一下", "待定一下", "看情况吧", "暂无内容",
                "以后再说吧", "TBD（待补）", "待办（回头再补）", "暂时不需要停止",
                # 复核 attempt 7：语气词归一了，标点没归一 —— 挂个省略号/波浪号照样绕过。
                "以后再补…", "以后再补吧～", "待办（回头再补）…", "待定…，回头再补",
            ]
            must_pass = [
                "待办列表点开就卡，先修这个", "不改待办排序", "先停", "卡住了",
                "待办列表点开就卡……", "先暂停导入，等我确认口径再说",
            ]

            def verify(_root, code, checks):
                leaked = [value for value in must_block if not is_placeholder(value)]
                if leaked:
                    return f"这些仍是占位符却放行了：{leaked}"
                killed = [value for value in must_pass if is_placeholder(value)]
                if killed:
                    return f"这些是正常写法却被判占位：{killed}"
                return ""
            return verify

        def placeholder_tone_word(root):
            # 端到端：同上第一条真的走一遍 M8，证明判定确实接在受理闸上。
            _selftest_repo(root, fields={"out_of_scope": "以后再补吧"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"「以后再补吧」应被 M8 拦，实际 {checks.get('M8')}"
                return ""
            return verify

        def dash_only(root):
            _selftest_repo(root, fields={"out_of_scope": "—"})

            def verify(_root, code, checks):
                if code == 0 or checks.get("M8", {}).get("state") != "BLOCKED":
                    return f"只有一个破折号应拦，实际 {checks.get('M8')}"
                return ""
            return verify

        def case_insensitive(root):
            # F4：Windows 上 Server.js 和 server.js 是同一个文件，判定不能大小写敏感。
            _selftest_repo(root)

            def verify(_root, code, checks):
                rules = protected_rules(root)
                if not is_protected("Server.js", rules):
                    return "大小写变体应该仍在受保护面内"
                if not path_covered("server.js", "Server.js"):
                    return "归属判定应大小写不敏感"
                if code != 0:
                    return f"本用例仍是正例，期望放行，实际 {code}"
                return ""
            return verify

        def legacy_epoch(root):
            _selftest_repo(root, epoch=3, fields={})

            def verify(_root, code, checks):
                if checks.get("M1", {}).get("state") != "PASS":
                    return f"旧 run 的 M1 应放行，实际 {checks.get('M1')}"
                if checks.get("M8", {}).get("state") != "NOT_RUN":
                    return f"旧 run 的 M8 应 NOT_RUN，实际 {checks.get('M8')}"
                if code != 0:
                    return f"pre-commit 对旧 run 不应拦，实际退出 {code}"
                return ""
            return verify

        return [
            ("正例：server-api 的 paths 覆盖 server.js → 放行", admitted),
            ("反例：契约摘要漂移（等于没有契约）→ M1 拦", drifted),
            ("反例：停条件为空 → M8 拦（M1 仍 PASS）", missing_field),
            ("反例：范围外写 <待填> → M8 拦", placeholder),
            ("反例：模块不拥有该文件（文件名不再当模块名）→ M1 拦", stem_guess),
            ("反例：只覆盖一部分受保护路径 → M1 拦", partial_cover),
            ("反例：范围外写「TBD 稍后补」→ M8 拦", weak_placeholder),
            ("反例：范围外写「待定，回头再补」→ M8 拦", placeholder_variants),
            ("反例：范围外写「以后再补」（无排除词）→ M8 拦", scope_word_salad),
            ("正例：范围外写「范围限于工具，留待后续」→ 放行", positive_scope_phrasing),
            ("正例：停条件写「先与用户确认再继续」→ 放行", positive_stop_phrasing),
            ("正例：停条件写「口径不清时与用户确认」→ 放行", positive_stop_short),
            ("反例：范围外写「不排除任何东西」→ M8 拦", non_answer_scope),
            ("反例：停条件写「不需要停止」→ M8 拦", non_answer_stop),
            ("正例：原话里含「待办」二字 → 放行", todo_word_in_quote),
            ("正例：停条件里含「稍后」二字 → 放行", later_word_in_stop),
            ("反例：占位词的等价类（+语气词/+括号补注）仍算占位", placeholder_equivalence_class),
            ("反例：范围外写「以后再补吧」→ M8 拦", placeholder_tone_word),
            ("反例：范围外只写一个破折号「—」→ M8 拦", dash_only),
            ("反例：验收命令没有期望结果 → M8 拦", command_shape),
            ("反例：原话没有引号 → M8 拦", quote_required),
            ("反例：蓝图写 `paths: *` 不得认领整棵树 → M1 拦", wildcard_blueprint),
            ("反例：蓝图不在索引/HEAD 时不得靠工作区扩权 → M1 拦", untracked_blueprint),
            ("正例：Server.js 大小写变体仍在受保护面内", case_insensitive),
            ("正例：受理字段写在第二个小节也能读到", sectioned),
            ("兼容：rule_epoch<4 的旧 run 不追接受理字段", legacy_epoch),
        ]

    failed = 0
    total = 0
    for name, check in cases():
        total += 1
        failed += expect(name, check)
    print(f"\n{'通过' if not failed else '失败'}：{total - failed}/{total} 个用例符合预期")
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fast", action="store_true", help="pre-commit subset (M1/M8/M3)")
    mode.add_argument("--ci", action="store_true", help="full set (M1-M8)")
    mode.add_argument(
        "--selftest",
        action="store_true",
        help="用临时仓库证明 M1/M8 真的会拦（不判当前仓库）",
    )
    parser.add_argument("--repo", default=".")
    parser.add_argument("--base", default=None)
    parser.add_argument(
        "--staged",
        action="store_true",
        help="judge the git index (git diff --cached) instead of base...HEAD; pre-commit use",
    )
    parser.add_argument(
        "--task",
        default=None,
        help="disambiguate staged contracts: the contract whose modules cover the change",
    )
    parser.add_argument(
        "--scope",
        choices=("project", "suite"),
        default="project",
        help="project: 项目仓库（默认，缺省不放松）；suite: 仅方法论仓库自身",
    )
    return parser


def exit_code(payload: dict) -> int:
    """Single source of truth for the process exit code, also stamped into the JSON."""
    if payload["status"] == "error":
        return 2
    if payload["status"] in ("pass", "pass_with_na"):
        return 0
    if payload.get("staged") and payload["status"] == "no_evidence":
        # Commit point only: no ledger yet is reported loudly but does not block.
        # The merge point (CI) keeps blocking every no_evidence, legacy included.
        return 0
    return 1


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.selftest:
        return run_selftest()
    payload = run(args)
    payload["exit"] = exit_code(payload)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return payload["exit"]


if __name__ == "__main__":
    raise SystemExit(main())
