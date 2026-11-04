"""Deterministic gates M1-M6.

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
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

PROTECTED_PREFIXES = ("app/", "specs/", "data/")
PROTECTED_FILES = ("AGENTS.md",)

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


def is_protected(path: str) -> bool:
    return path.startswith(PROTECTED_PREFIXES) or path in PROTECTED_FILES


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_text(text: str) -> dict[str, str]:
    """Parse the leading `key: value` block of a task.md / verdict.md.

    Only snake_case keys count as fields: a contract may start with prose
    (验收标准) that contains colons, and prose must not poison the machine header.
    """
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            if fields:
                break
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
    for run_dir in run_directories(repo):
        relative = run_dir.relative_to(repo).as_posix()
        events = _read_run_events(run_dir)
        _verify_chain(relative, events)
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


def declared_modules(fields: dict[str, str]) -> set[str]:
    raw = fields.get("modules", "")
    names = set()
    for item in MODULE_SEPARATOR.split(raw):
        name = item.strip("[]").replace("-", "_").casefold()
        if name and not name.startswith("<"):
            names.add(name)
    return names - {"none"}


def module_intersects(names: set[str], paths: list[str]) -> bool:
    """A contract covers a path only when the file name names a declared module.

    `specs/modules/excel-generator.md` and `app/utils/excel_generator.py` both name
    the module `excel_generator`; an unrelated module never matches by accident.
    """
    return any(
        Path(path).stem.replace("-", "_").casefold() in names for path in paths
    )


def check_m1(
    repo: Path, base: str, staged: bool = False, task: str | None = None
) -> tuple[bool | None, str]:
    paths = changed_paths(repo, base, staged)
    if staged and not paths:
        # An empty index is not a pass: nothing was judged.
        return None, "no staged changes: nothing evaluated"
    touched = [path for path in paths if is_protected(path)]
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
        contracts = staged_contracts(repo)
        if not contracts:
            return False, (
                f"protected staged change without contract (no matching PLANNED "
                f"contract_digest): {touched[:5]}"
            )
        candidates = [
            (contract_task, fields)
            for contract_task, fields in contracts
            if module_intersects(declared_modules(fields), touched)
        ]
        if task:
            chosen = next((item for item in candidates if item[0] == task), None)
            if chosen is None:
                return False, (
                    f"--task {task} does not cover staged protected paths {touched[:5]} "
                    "(declared modules must intersect the changed files)"
                )
        elif len(candidates) == 1:
            chosen = candidates[0]
        elif candidates:
            return False, (
                f"ambiguous staged contract for {touched[:5]}: "
                f"{[item[0] for item in candidates]} (pass --task <task_id>; "
                "the gate does not guess)"
            )
        else:
            return False, (
                f"protected staged change without contract (no matching PLANNED "
                f"contract_digest): {touched[:5]}"
            )
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
    grade = parse_record(task).get("gate_level", "")
    if grade not in GRADE_RANK:
        return False, f"task.md has invalid gate_level={grade!r}"
    if GRADE_RANK[grade] == 0:
        return False, f"{task_id} declared G0 but touches contract-face paths: {touched[:5]}"
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


def check_m3(repo: Path, base: str, staged: bool = False) -> tuple[bool | None, str]:
    paths = changed_paths(repo, base, staged)
    if staged and not paths:
        return None, "no staged changes: nothing evaluated"
    touched = [path for path in paths if is_protected(path)]
    if not touched:
        detail = "no protected path changed"
        if staged:
            detail += " (unstaged worktree changes are not evaluated)"
        return True, detail
    if staged:
        contracts = staged_contracts(repo)
        if not contracts:
            return None, "NOT_RUN: 暂存区没有与 task.md 匹配的 PLANNED 契约，M3 无从校验"
        task_id, fields = contracts[0]
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
        ("M3", lambda: check_m3(repo, base, staged)),
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fast", action="store_true", help="pre-commit subset (M1/M3)")
    mode.add_argument("--ci", action="store_true", help="full set (M1-M6)")
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
    payload = run(args)
    payload["exit"] = exit_code(payload)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return payload["exit"]


if __name__ == "__main__":
    raise SystemExit(main())
