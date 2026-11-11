"""Maintain and validate a deterministic append-only agent workflow ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

GENESIS_HASH = "0" * 64
# Gate rules in force when a run is born. Old runs keep their own epoch, so
# tightening the rules never rewrites or re-judges existing evidence.
# 4 = M8 受理闸生效（task.md 受理五字段）；M2 仍按 >=3 判定，两个代次互不影响。
RULE_EPOCH = 4
ROLES = {name.casefold(): name for name in ("Planner", "Worker", "Reviewer", "Human")}
REVIEW_VERDICTS = {
    "PASS",
    "FAIL_IMPLEMENTATION",
    "FAIL_DESIGN",
    "NEEDS_BUSINESS_DECISION",
    "BLOCKED",
}
VALID_STATES = {
    "PLANNED",
    "IN_PROGRESS",
    "READY_FOR_REVIEW",
    *REVIEW_VERDICTS,
    "ACCEPTED",
    "ACTIVE",
}
TARGET_ROLES = {
    "IN_PROGRESS": "Worker",
    "READY_FOR_REVIEW": "Worker",
    **{verdict: "Reviewer" for verdict in REVIEW_VERDICTS},
    "ACCEPTED": "Human",
    "ACTIVE": "Planner",
}
TRANSITIONS = {
    "PLANNED": {"IN_PROGRESS"},
    "IN_PROGRESS": {"READY_FOR_REVIEW"},
    "READY_FOR_REVIEW": REVIEW_VERDICTS,
    "PASS": {"ACCEPTED"},
    "ACCEPTED": {"ACTIVE"},
}
EVENT_KEYS = {"seq", "previous_hash", "event_hash", "state", "role", "metadata", "evidence"}
CANDIDATE_SNAPSHOT_NAME = "candidate-snapshot.bin"
CANDIDATE_METADATA_KEYS = (
    "candidate_source_path",
    "candidate_snapshot_path",
    "candidate_snapshot_identity",
    "candidate_revision",
    "candidate_digest",
)


class PublicError(Exception):
    """A deterministic public-command failure."""

    def __init__(self, error_code: str, **details: object) -> None:
        super().__init__(error_code)
        self.payload = {"error_code": error_code, **details}


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise PublicError("invalid_arguments", message=message)


def _canonical_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _event_hash(event: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in event.items() if key != "event_hash"}
    return _digest_bytes(_canonical_bytes(unsigned))


def _evidence_record(evidence: Path | None) -> dict[str, str]:
    if evidence is None:
        raise PublicError("missing_evidence")
    try:
        resolved = evidence.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PublicError("evidence_not_found", path=str(evidence)) from exc
    if not resolved.is_file():
        raise PublicError("evidence_not_found", path=str(evidence))
    try:
        digest = _digest_bytes(resolved.read_bytes())
    except OSError as exc:
        raise PublicError("evidence_unreadable", path=str(resolved)) from exc
    return {"path": str(resolved), "sha256": digest}


def _contract_record(contract: Path | None) -> dict[str, str]:
    """Freeze the reviewed task contract so M1 can detect later digest drift."""
    if contract is None:
        raise PublicError("missing_contract")
    try:
        resolved = contract.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PublicError("contract_not_found", path=str(contract)) from exc
    if not resolved.is_file():
        raise PublicError("contract_not_found", path=str(contract))
    try:
        digest = _digest_bytes(resolved.read_bytes())
    except OSError as exc:
        raise PublicError("contract_unreadable", path=str(resolved)) from exc
    return {"contract_path": str(resolved), "contract_digest": digest}


def _candidate_source_bytes(
    candidate: Path | None,
    revision: str | None,
    supplied_digest: str | None = None,
) -> tuple[Path, bytes, str, str]:
    if candidate is None or revision is None or not revision.strip():
        raise PublicError("missing_candidate_identity")
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as exc:
        raise PublicError("candidate_not_found", path=str(candidate)) from exc
    except (OSError, RuntimeError) as exc:
        raise PublicError("candidate_unreadable", path=str(candidate)) from exc
    try:
        if not stat.S_ISREG(resolved.lstat().st_mode):
            raise PublicError("candidate_not_file", path=str(resolved))
    except PublicError:
        raise
    except OSError as exc:
        raise PublicError("candidate_unreadable", path=str(resolved)) from exc
    try:
        with resolved.open("rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise PublicError("candidate_not_file", path=str(resolved))
            candidate_bytes = stream.read()
    except IsADirectoryError as exc:
        raise PublicError("candidate_not_file", path=str(resolved)) from exc
    except PublicError:
        raise
    except OSError as exc:
        raise PublicError("candidate_unreadable", path=str(resolved)) from exc
    digest = _digest_bytes(candidate_bytes)
    if supplied_digest is not None and supplied_digest != digest:
        raise PublicError("candidate_digest_mismatch", path=str(resolved))
    return resolved, candidate_bytes, revision, digest


def _snapshot_identity(file_stat: os.stat_result) -> str:
    device = getattr(file_stat, "st_dev", None)
    inode = getattr(file_stat, "st_ino", None)
    if not isinstance(device, int) or not isinstance(inode, int) or inode <= 0:
        return "unavailable"
    return f"device-inode:{device}:{inode}"


def _seal_candidate(
    run_dir: Path,
    candidate: Path | None,
    revision: str | None,
    supplied_digest: str | None = None,
) -> dict[str, str]:
    source, candidate_bytes, candidate_revision, digest = _candidate_source_bytes(
        candidate,
        revision,
        supplied_digest,
    )
    snapshot = (run_dir / CANDIDATE_SNAPSHOT_NAME).absolute()
    # Atomic: the bytes land under a temporary name first, so a failure before the
    # event is appended can never leave a snapshot that no ledger event references.
    temporary = snapshot.with_name(f"{CANDIDATE_SNAPSHOT_NAME}.tmp-{os.getpid()}")
    try:
        with temporary.open("xb") as stream:
            stream.write(candidate_bytes)
            stream.flush()
            os.fsync(stream.fileno())
            identity = _snapshot_identity(os.fstat(stream.fileno()))
        if snapshot.exists():
            raise PublicError("candidate_snapshot_exists", path=str(snapshot))
        os.replace(temporary, snapshot)
    except PublicError:
        temporary.unlink(missing_ok=True)
        raise
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise PublicError(
            "candidate_snapshot_write_failed", path=str(snapshot), message=str(exc)
        ) from exc
    return {
        "candidate_source_path": str(source),
        "candidate_snapshot_path": str(snapshot),
        "candidate_snapshot_identity": identity,
        "candidate_revision": candidate_revision,
        "candidate_digest": digest,
    }


def _verify_candidate_metadata(
    metadata: dict[str, Any], *, seq: int, run_dir: Path
) -> dict[str, str]:
    candidate_source_path = metadata.get("candidate_source_path")
    candidate_snapshot_path = metadata.get("candidate_snapshot_path")
    candidate_snapshot_identity = metadata.get("candidate_snapshot_identity")
    candidate_revision = metadata.get("candidate_revision")
    candidate_digest = metadata.get("candidate_digest")
    if not all(
        isinstance(value, str) and value.strip()
        for value in (
            candidate_source_path,
            candidate_snapshot_path,
            candidate_snapshot_identity,
            candidate_revision,
            candidate_digest,
        )
    ):
        raise PublicError("missing_candidate_identity", seq=seq)
    snapshot = Path(candidate_snapshot_path)
    expected_snapshot = (run_dir / CANDIDATE_SNAPSHOT_NAME).absolute()
    if os.path.normcase(os.path.abspath(snapshot)) != os.path.normcase(
        os.path.abspath(expected_snapshot)
    ):
        raise PublicError("candidate_snapshot_path_mismatch", seq=seq)
    try:
        snapshot_lstat = snapshot.lstat()
    except FileNotFoundError as exc:
        raise PublicError("candidate_snapshot_not_found", seq=seq, path=str(snapshot)) from exc
    except OSError as exc:
        raise PublicError("candidate_snapshot_unreadable", seq=seq, path=str(snapshot)) from exc
    if not stat.S_ISREG(snapshot_lstat.st_mode):
        raise PublicError("candidate_snapshot_replaced", seq=seq, path=str(snapshot))
    try:
        with snapshot.open("rb") as stream:
            opened_stat = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened_stat.st_mode):
                raise PublicError("candidate_snapshot_replaced", seq=seq, path=str(snapshot))
            snapshot_bytes = stream.read()
    except FileNotFoundError as exc:
        raise PublicError("candidate_snapshot_not_found", seq=seq, path=str(snapshot)) from exc
    except IsADirectoryError as exc:
        raise PublicError("candidate_snapshot_replaced", seq=seq, path=str(snapshot)) from exc
    except PublicError:
        raise
    except OSError as exc:
        raise PublicError("candidate_snapshot_unreadable", seq=seq, path=str(snapshot)) from exc
    opened_identity = _snapshot_identity(opened_stat)
    if (
        candidate_snapshot_identity != "unavailable"
        and opened_identity != "unavailable"
        and opened_identity != candidate_snapshot_identity
    ):
        raise PublicError("candidate_snapshot_replaced", seq=seq, path=str(snapshot))
    if _digest_bytes(snapshot_bytes) != candidate_digest:
        raise PublicError("candidate_digest_mismatch", seq=seq, path=str(snapshot))
    return {key: str(metadata[key]) for key in CANDIDATE_METADATA_KEYS}


def _append_event(ledger: Path, event: dict[str, Any], *, initialize: bool = False) -> None:
    event["event_hash"] = _event_hash(event)
    serialized = json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n"
    mode = "x" if initialize else "a"
    try:
        with ledger.open(mode, encoding="utf-8", newline="\n") as stream:
            stream.write(serialized)
    except FileExistsError as exc:
        raise PublicError("run_already_initialized", path=str(ledger.parent)) from exc
    except OSError as exc:
        raise PublicError("ledger_write_failed", path=str(ledger), message=str(exc)) from exc


def _load_events(run_dir: Path) -> list[dict[str, Any]]:
    ledger = run_dir / "events.jsonl"
    if not run_dir.is_dir() or not ledger.is_file():
        raise PublicError("run_not_found", path=str(run_dir))
    try:
        lines = ledger.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise PublicError("invalid_ledger", message=str(exc)) from exc
    events: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise PublicError("invalid_ledger", line=line_number, message=str(exc)) from exc
        if not isinstance(event, dict):
            raise PublicError("invalid_ledger", line=line_number)
        events.append(event)
    if not events:
        raise PublicError("invalid_ledger", message="event ledger is empty")
    return events


def _validate_events(events: list[dict[str, Any]], run_dir: Path) -> None:
    previous_hash = GENESIS_HASH
    previous_state: str | None = None
    bound_candidate: dict[str, str] | None = None
    for expected_seq, event in enumerate(events, start=1):
        if not EVENT_KEYS.issubset(event):
            raise PublicError("invalid_ledger", seq=expected_seq, message="event fields are missing")
        if event.get("seq") != expected_seq:
            raise PublicError("invalid_sequence", seq=expected_seq)
        if event.get("previous_hash") != previous_hash:
            raise PublicError("previous_hash_mismatch", seq=expected_seq)
        if event.get("event_hash") != _event_hash(event):
            raise PublicError("event_hash_mismatch", seq=expected_seq)

        state = event.get("state")
        role = event.get("role")
        metadata = event.get("metadata")
        evidence = event.get("evidence")
        if state not in VALID_STATES or role not in ROLES.values() or not isinstance(metadata, dict):
            raise PublicError("invalid_ledger", seq=expected_seq, message="invalid state, role, or metadata")
        if expected_seq == 1:
            if state != "PLANNED" or role != "Planner":
                raise PublicError("invalid_ledger", seq=expected_seq, message="invalid initialization")
            required = ("task_id", "contract_version", "base_revision", "contract_digest")
            if any(not metadata.get(field) for field in required):
                raise PublicError("invalid_ledger", seq=expected_seq, message="initial metadata is incomplete")
        else:
            if state not in TRANSITIONS.get(str(previous_state), set()):
                raise PublicError("invalid_transition", from_state=previous_state, to_state=state)
            if TARGET_ROLES.get(str(state)) != role:
                raise PublicError("actor_forbidden", role=role, state=state)
            if state == "READY_FOR_REVIEW":
                bound_candidate = _verify_candidate_metadata(
                    metadata, seq=expected_seq, run_dir=run_dir
                )
            elif bound_candidate is not None:
                inherited = {
                    key: metadata.get(key)
                    for key in CANDIDATE_METADATA_KEYS
                }
                if inherited != bound_candidate:
                    raise PublicError("candidate_identity_mismatch", seq=expected_seq)
                _verify_candidate_metadata(metadata, seq=expected_seq, run_dir=run_dir)

        if not isinstance(evidence, dict) or not isinstance(evidence.get("path"), str):
            raise PublicError("invalid_ledger", seq=expected_seq, message="invalid evidence record")
        if not isinstance(evidence.get("sha256"), str):
            raise PublicError("invalid_ledger", seq=expected_seq, message="invalid evidence digest")
        evidence_path = Path(evidence["path"])
        if not evidence_path.is_file():
            raise PublicError("evidence_not_found", seq=expected_seq, path=str(evidence_path))
        try:
            actual_digest = _digest_bytes(evidence_path.read_bytes())
        except OSError as exc:
            raise PublicError("evidence_unreadable", seq=expected_seq, path=str(evidence_path)) from exc
        if actual_digest != evidence["sha256"]:
            raise PublicError("evidence_digest_mismatch", seq=expected_seq, path=str(evidence_path))

        previous_hash = str(event["event_hash"])
        previous_state = str(state)


def validate_run(run_dir: Path) -> list[dict[str, Any]]:
    events = _load_events(run_dir)
    _validate_events(events, run_dir)
    return events


def initialize(
    run_dir: Path,
    task_id: str,
    contract_version: int,
    base_revision: str,
    evidence: Path | None,
    contract: Path | None,
) -> dict[str, object]:
    if not task_id.strip():
        raise PublicError("invalid_task_id")
    if contract_version < 1:
        raise PublicError("invalid_contract_version")
    if not base_revision.strip():
        raise PublicError("invalid_base_revision")
    evidence_record = _evidence_record(evidence)
    contract_record = _contract_record(contract)
    if run_dir.exists() and not run_dir.is_dir():
        raise PublicError("invalid_run_directory", path=str(run_dir))
    try:
        run_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise PublicError("invalid_run_directory", path=str(run_dir), message=str(exc)) from exc
    event: dict[str, Any] = {
        "seq": 1,
        "previous_hash": GENESIS_HASH,
        "event_hash": "",
        "state": "PLANNED",
        "role": "Planner",
        "metadata": {
            "task_id": task_id,
            "contract_version": contract_version,
            "base_revision": base_revision,
            "rule_epoch": RULE_EPOCH,
            **contract_record,
        },
        "evidence": evidence_record,
    }
    _append_event(run_dir / "events.jsonl", event, initialize=True)
    return {"status": "success", "state": "PLANNED", "event_hash": event["event_hash"]}


def bump_contract(
    run_dir: Path,
    contract_version: int,
    base_revision: str,
    evidence: Path | None,
    contract: Path | None,
) -> dict[str, object]:
    """Raise the contract version inside the same run, before work starts.

    It used to open a sibling `<task_id>-cvN/` run, which meant a contract bump
    restarted the state machine from a fresh PLANNED event: the old chain's
    history stayed in another directory and the new one looked untouched. The
    gate now rejects two chains for one task, so a bump rewrites the single
    PLANNED event at the higher version — allowed only while nothing but the
    plan exists. Once work has started, a changed contract is a new task, not a
    silent restart.
    """
    events = validate_run(run_dir)
    task_id = str(events[0].get("metadata", {}).get("task_id", ""))
    recorded = max(
        int(event.get("metadata", {}).get("contract_version", 0))
        for event in events
        if event.get("state") == "PLANNED"
    )
    if contract_version <= recorded:
        raise PublicError("contract_version_not_higher", recorded=recorded)
    if any(event.get("state") != "PLANNED" for event in events):
        raise PublicError(
            "contract_bump_after_work_started",
            task_id=task_id,
            hint="已进入实现/复核的链不重写；契约变了请开新 task_id",
        )
    ledger = run_dir / "events.jsonl"
    recorded_bytes = ledger.read_bytes()
    ledger.unlink()
    try:
        initialize(run_dir, task_id, contract_version, base_revision, evidence, contract)
    except PublicError:
        ledger.write_bytes(recorded_bytes)
        raise
    return {
        "status": "success",
        "state": "PLANNED",
        "run": run_dir.as_posix(),
        "contract_version": contract_version,
    }


RUNS_ROOT = "artifacts/runs"


def _gate_module() -> Any:
    """Reuse the gate's field tuples so the two sides cannot drift."""
    gates = Path(__file__).resolve().parents[1] / "gates"
    if str(gates) not in sys.path:
        sys.path.insert(0, str(gates))
    import gate

    return gate


def _run_candidates(run_root: Path, task_id: str) -> list[Path]:
    if not run_root.is_dir():
        return []
    # 精确匹配一个目录：`<task_id>-cvN` 那种「另一条链」已经不合法（gate 会判同任务双链）。
    path = run_root / task_id
    return [path] if path.is_dir() and (path / "events.jsonl").is_file() else []


def _latest_run(run_root: Path, task_id: str) -> Path:
    candidates = _run_candidates(run_root, task_id)
    if not candidates:
        raise PublicError("run_not_found", task_id=task_id, run_root=str(run_root))
    return candidates[0]


def task_start(
    task_id: str,
    contract: Path | None,
    gate_level: str,
    evidence: Path | None,
    base_revision: str,
    contract_version: int,
    run_root: Path,
) -> dict[str, object]:
    """One command for the 开工 step: verify the contract, then open the ledger."""
    gate = _gate_module()
    fields = gate.parse_record(contract) if contract else {}
    declared = fields.get("gate_level", "")
    if declared != gate_level:
        raise PublicError("gate_level_mismatch", declared=declared, requested=gate_level)
    run_dir = run_root / task_id
    initialize(run_dir, task_id, contract_version, base_revision, evidence, contract)
    return {
        "status": "success",
        "state": "PLANNED",
        "run": run_dir.as_posix(),
        "gate_level": gate_level,
        "next": "改代码/文档 → git add → 写 delivery.md 与 verdict.md → task submit",
    }


def _capture_diff(task_dir: Path, revision: str) -> Path:
    """Seal what is actually being reviewed: the diff against HEAD, not a hand-made file."""
    task_dir.mkdir(parents=True, exist_ok=True)
    target = task_dir / f"candidate-a{revision}.patch"
    result = subprocess.run(
        ["git", "diff", "--binary", "HEAD"], capture_output=True, check=False
    )
    if result.returncode != 0:
        raise PublicError(
            "candidate_capture_failed", message=result.stderr.decode("utf-8", "replace")[:200]
        )
    if not result.stdout:
        raise PublicError("candidate_capture_empty", hint="git diff HEAD 为空：先改动再提交")
    target.write_bytes(result.stdout)
    return target


def task_submit(
    task_id: str,
    verdict: Path | None,
    delivery: Path | None,
    evidence: Path | None,
    candidate_path: Path | None,
    candidate_revision: str,
    candidate_digest: str | None,
    run_root: Path,
) -> dict[str, object]:
    """Check both records, then seal the candidate and record READY + PASS.

    It never writes verdict/delivery content: a machine that authors evidence turns
    the ledger into a rubber stamp.
    """
    gate = _gate_module()
    verdict_fields = gate.parse_record(verdict) if verdict else {}
    delivery_fields = gate.parse_record(delivery) if delivery else {}
    missing = [name for name in gate.VERDICT_REQUIRED_FIELDS if not verdict_fields.get(name)]
    if missing:
        raise PublicError("incomplete_record", record="verdict", missing=missing, path=str(verdict))
    missing = [name for name in gate.DELIVERY_REQUIRED_FIELDS if not delivery_fields.get(name)]
    if missing:
        raise PublicError("incomplete_record", record="delivery", missing=missing, path=str(delivery))
    if verdict_fields["verdict"] != gate.VERDICT_PASS_VALUE:
        raise PublicError("verdict_not_pass", verdict=verdict_fields["verdict"])
    for record_name, fields in (("verdict", verdict_fields), ("delivery", delivery_fields)):
        if fields.get("task_id") and fields["task_id"] != task_id:
            raise PublicError("record_task_id_mismatch", record=record_name, recorded=fields["task_id"])
        if str(fields["candidate_revision"]) != candidate_revision:
            raise PublicError(
                "record_revision_mismatch",
                record=record_name,
                recorded=fields["candidate_revision"],
                requested=candidate_revision,
            )
    if candidate_path is None:
        candidate_path = _capture_diff(run_root / task_id, candidate_revision)
    _, _, _, digest = _candidate_source_bytes(candidate_path, candidate_revision, candidate_digest)
    for record_name, fields in (("verdict", verdict_fields), ("delivery", delivery_fields)):
        if fields["candidate_digest"] != digest:
            raise PublicError("record_candidate_digest_mismatch", record=record_name)
    run_dir = _latest_run(run_root, task_id)
    state = str(validate_run(run_dir)[-1]["state"])
    added = 0
    if state == "PASS":
        raise PublicError("already_passed", task_id=task_id)
    if state == "PLANNED":
        transition(run_dir, "Worker", "IN_PROGRESS", evidence)
        added += 1
        state = "IN_PROGRESS"
    if state != "READY_FOR_REVIEW" and state != "IN_PROGRESS":
        raise PublicError("invalid_state", state=state)
    if state == "IN_PROGRESS":
        transition(run_dir, "Worker", "READY_FOR_REVIEW", evidence, candidate_revision, candidate_path, digest)
        added += 1
    transition(run_dir, "Reviewer", "PASS", evidence)
    added += 1
    return {
        "status": "success",
        "state": "PASS",
        "run": run_dir.as_posix(),
        "events_added": added,
        "next": "gate.py --fast --staged → 带 `Task:` trailer 提交 → gate.py --ci",
    }


def task_check(task_id: str, run_root: Path) -> dict[str, object]:
    """Print the current state and the exact next actions, so nobody memorises order."""
    gate = _gate_module()
    run_dir = _latest_run(run_root, task_id)
    events = validate_run(run_dir)
    state = str(events[-1]["state"])
    contract_path = run_root / task_id / "task.md"
    fields = gate.parse_record(contract_path) if contract_path.is_file() else {}
    planned = next(event for event in events if event["state"] == "PLANNED")
    steps = {
        "PLANNED": [
            "改代码/文档，git add 受保护路径",
            "写 delivery.md（含 not_run）与 verdict.md",
            f"agent_workflow.py task submit --task-id {task_id} --candidate-path <patch> --evidence <log>",
            "gate.py --fast --staged",
            f"带 `Task: {task_id}` trailer 提交",
        ],
        "IN_PROGRESS": [
            "写 delivery.md 与 verdict.md",
            f"agent_workflow.py task submit --task-id {task_id} --candidate-path <patch> --evidence <log>",
            "gate.py --fast --staged",
            f"带 `Task: {task_id}` trailer 提交",
        ],
        "READY_FOR_REVIEW": [
            "写 verdict.md（Reviewer 独立上下文）",
            f"agent_workflow.py task submit --task-id {task_id}（同一候选）",
            "gate.py --fast --staged",
            f"带 `Task: {task_id}` trailer 提交",
        ],
        "PASS": (
            ["已完成：trailer 已提交", "gate.py --ci"]
            if _trailer_committed(task_id)
            else [f"带 `Task: {task_id}` trailer 提交", "gate.py --ci"]
        ),
    }
    return {
        "status": "success",
        "task_id": task_id,
        "run": run_dir.as_posix(),
        "state": state,
        "gate_level": fields.get("gate_level", ""),
        "contract_version": planned.get("metadata", {}).get("contract_version"),
        "next": steps.get(state, []),
    }


def _trailer_committed(task_id: str) -> bool:
    """The trailer only exists in the commit message, so PASS cannot be confirmed from the ledger."""
    try:
        messages = subprocess.run(
            ["git", "log", "--format=%B", "-20"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return False
    return bool(re.search(rf"^Task:\s*{re.escape(task_id)}\s*$", messages, re.MULTILINE))


def transition(
    run_dir: Path,
    role_value: str,
    target_value: str,
    evidence: Path | None,
    candidate_revision: str | None = None,
    candidate_path: Path | None = None,
    candidate_digest: str | None = None,
) -> dict[str, object]:
    target = target_value.upper()
    if target not in VALID_STATES or target == "PLANNED":
        raise PublicError("invalid_state", state=target_value)
    role = ROLES.get(role_value.casefold())
    if role is None:
        raise PublicError("invalid_role", role=role_value)
    if TARGET_ROLES.get(target) != role:
        raise PublicError("actor_forbidden", role=role, state=target)
    events = validate_run(run_dir)
    source = str(events[-1]["state"])
    if target not in TRANSITIONS.get(source, set()):
        raise PublicError("invalid_transition", from_state=source, to_state=target)
    metadata: dict[str, object] = {
        "task_id": events[0]["metadata"]["task_id"],
    }
    # Validate evidence before touching the filesystem: a rejected transition must
    # not leave a sealed snapshot behind (that orphan used to force a manual delete).
    evidence_record = _evidence_record(evidence)
    sealed_snapshot: Path | None = None
    sealed = False
    if target == "READY_FOR_REVIEW":
        metadata.update(
            _seal_candidate(
                run_dir,
                candidate_path,
                candidate_revision,
                candidate_digest,
            )
        )
        sealed_snapshot = Path(str(metadata["candidate_snapshot_path"]))
        sealed = True
    else:
        ready_event = next(
            (event for event in events if event["state"] == "READY_FOR_REVIEW"),
            None,
        )
        if ready_event is not None:
            metadata.update(
                {
                    key: ready_event["metadata"][key]
                    for key in CANDIDATE_METADATA_KEYS
                }
            )
            sealed = True
    event: dict[str, Any] = {
        "seq": len(events) + 1,
        "previous_hash": events[-1]["event_hash"],
        "event_hash": "",
        "state": target,
        "role": role,
        "metadata": metadata,
        "evidence": evidence_record,
    }
    try:
        if sealed:
            _verify_candidate_metadata(metadata, seq=len(events) + 1, run_dir=run_dir)
        _append_event(run_dir / "events.jsonl", event)
    except BaseException:
        # Roll back the snapshot: an event that never landed must not leave bytes behind.
        if sealed_snapshot is not None:
            sealed_snapshot.unlink(missing_ok=True)
        raise
    return {"status": "success", "state": target, "event_hash": event["event_hash"]}


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description=__doc__)
    commands = parser.add_subparsers(
        dest="command", required=True, parser_class=JsonArgumentParser
    )

    init_parser = commands.add_parser("init")
    init_parser.add_argument("run_dir")
    init_parser.add_argument("--task-id", required=True)
    init_parser.add_argument("--contract-version", required=True, type=int)
    init_parser.add_argument("--base-revision", required=True)
    init_parser.add_argument("--evidence")
    init_parser.add_argument("--contract", required=True)

    transition_parser = commands.add_parser("transition")
    transition_parser.add_argument("run_dir")
    transition_parser.add_argument("--role", required=True)
    transition_parser.add_argument("--to", required=True, dest="target")
    transition_parser.add_argument("--evidence")
    transition_parser.add_argument("--candidate-revision")
    transition_parser.add_argument("--candidate-path")
    transition_parser.add_argument("--candidate-digest")

    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("run_dir")

    bump_parser = commands.add_parser("bump-contract")
    bump_parser.add_argument("run_dir")
    bump_parser.add_argument("--contract-version", required=True, type=int)
    bump_parser.add_argument("--base-revision", required=True)
    bump_parser.add_argument("--evidence")
    bump_parser.add_argument("--contract", required=True)

    task_parser = commands.add_parser("task", help="one-command wrappers over the primitives")
    task_commands = task_parser.add_subparsers(
        dest="task_command", required=True, parser_class=JsonArgumentParser
    )
    start_parser = task_commands.add_parser("start")
    start_parser.add_argument("--task-id", required=True)
    start_parser.add_argument("--contract", required=True)
    start_parser.add_argument("--gate-level", required=True)
    start_parser.add_argument("--evidence")
    start_parser.add_argument("--base-revision", default="HEAD")
    start_parser.add_argument("--contract-version", default=1, type=int)
    start_parser.add_argument("--run-root", default=RUNS_ROOT)

    submit_parser = task_commands.add_parser("submit")
    submit_parser.add_argument("--task-id", required=True)
    submit_parser.add_argument("--verdict")
    submit_parser.add_argument("--delivery")
    submit_parser.add_argument("--evidence")
    submit_parser.add_argument("--candidate-path", help="省略时用 git diff HEAD 自动封存")
    submit_parser.add_argument("--candidate-revision", default="1")
    submit_parser.add_argument("--candidate-digest")
    submit_parser.add_argument("--run-root", default=RUNS_ROOT)

    check_parser = task_commands.add_parser("check")
    check_parser.add_argument("--task-id", required=True)
    check_parser.add_argument("--run-root", default=RUNS_ROOT)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        if args.command == "init":
            payload = initialize(
                Path(args.run_dir),
                args.task_id,
                args.contract_version,
                args.base_revision,
                Path(args.evidence) if args.evidence else None,
                Path(args.contract) if args.contract else None,
            )
        elif args.command == "transition":
            payload = transition(
                Path(args.run_dir),
                args.role,
                args.target,
                Path(args.evidence) if args.evidence else None,
                args.candidate_revision,
                Path(args.candidate_path) if args.candidate_path else None,
                args.candidate_digest,
            )
        elif args.command == "bump-contract":
            payload = bump_contract(
                Path(args.run_dir),
                args.contract_version,
                args.base_revision,
                Path(args.evidence) if args.evidence else None,
                Path(args.contract) if args.contract else None,
            )
        elif args.command == "task":
            run_root = Path(args.run_root)
            if args.task_command == "start":
                payload = task_start(
                    args.task_id,
                    Path(args.contract) if args.contract else None,
                    args.gate_level,
                    Path(args.evidence) if args.evidence else None,
                    args.base_revision,
                    args.contract_version,
                    run_root,
                )
            elif args.task_command == "submit":
                payload = task_submit(
                    args.task_id,
                    Path(args.verdict) if args.verdict else None,
                    Path(args.delivery) if args.delivery else None,
                    Path(args.evidence) if args.evidence else None,
                    Path(args.candidate_path) if args.candidate_path else None,
                    args.candidate_revision,
                    args.candidate_digest,
                    run_root,
                )
            else:
                payload = task_check(args.task_id, run_root)
        else:
            validate_run(Path(args.run_dir))
            payload = {"status": "success"}
    except PublicError as exc:
        print(json.dumps(exc.payload, sort_keys=True), file=sys.stderr)
        return 2
    except Exception as exc:  # Defensive boundary: public failures stay machine-readable.
        print(json.dumps({"error_code": "internal_error", "message": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
