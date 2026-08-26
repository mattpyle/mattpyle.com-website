# ABOUTME: Reads the machine-readable marking sheet at run time.
#
# The pack's sheets are prose with structure buried in them; the code pass needs the structure.
# The sheet file derived from the pack lives in the vault beside it and is passed to the marker by
# path, exactly like the task pack: no marking criterion is embedded in this repository's code.
# Every marking transcript records the file's path and content hash, so a mark names the sheet
# that produced it.

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "Point",
    "TaskSheet",
    "MarkingSheet",
    "load_sheet",
    "default_sheet_path",
]

SHEET_RELATIVE_PATH = "docs/reference/benchmark-marking-sheet-temporal-v1.yaml"

CODE = "code"
JUDGE = "judge"
_VALID_CHECKS = frozenset({CODE, JUDGE})

_POINT_KEYS = frozenset(
    {
        "id",
        "text",
        "checks",
        "citation_allowlist",
        "citation_mechanics",
        "citation_hosts",
        "required_strings",
        "requires_justification",
    }
)


@dataclass(frozen=True)
class Point:
    """One marking point, with whatever structure the code pass can act on."""

    id: str
    text: str
    checks: tuple[str, ...]
    citation_allowlist: tuple[str, ...] = ()
    citation_mechanics: bool = False
    citation_hosts: tuple[str, ...] = ()
    # Groups of alternatives: the answer must contain one alternative from every group.
    required_strings: tuple[tuple[str, ...], ...] = ()
    requires_justification: bool = False

    @property
    def code_checked(self) -> bool:
        return CODE in self.checks

    @property
    def judge_checked(self) -> bool:
        return JUDGE in self.checks


@dataclass(frozen=True)
class TaskSheet:
    number: int
    title: str
    points: tuple[Point, ...]
    # Fetched at marking time and put in front of the judge, so a docs change between run and
    # marking reads as a docs change rather than an agent error (pack rule 5).
    live_pages: tuple[str, ...] = ()

    def point(self, point_id: str) -> Point | None:
        return next((p for p in self.points if p.id == point_id), None)


@dataclass(frozen=True)
class MarkingSheet:
    version: str
    path: Path
    sha256: str
    derived_from: dict[str, Any] = field(default_factory=dict)
    tasks: tuple[TaskSheet, ...] = ()

    def task(self, number: int) -> TaskSheet:
        for task in self.tasks:
            if task.number == number:
                return task
        raise SystemExit(f"marking sheet {self.path} has no task {number}")

    def identity(self) -> dict[str, str]:
        """What the marking transcript records about this file."""
        return {"path": str(self.path), "sha256": self.sha256, "version": self.version}


def default_sheet_path() -> Path:
    """`BENCHMARK_MARKING_SHEET` if set, else the vault copy in this repository."""
    from_env = os.environ.get("BENCHMARK_MARKING_SHEET")
    if from_env:
        return Path(from_env).expanduser()
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / SHEET_RELATIVE_PATH


def load_sheet(path: Path | None = None) -> MarkingSheet:
    """Parse the sheet file, refusing anything it cannot mark from."""
    import yaml

    file_path = path or default_sheet_path()
    if not file_path.is_file():
        raise SystemExit(
            f"marking sheet not found at {file_path}. Set BENCHMARK_MARKING_SHEET to its location."
        )

    raw_bytes = file_path.read_bytes()
    data = yaml.safe_load(raw_bytes.decode("utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"marking sheet {file_path} is not a mapping")

    tasks_raw = data.get("tasks")
    if not isinstance(tasks_raw, list) or not tasks_raw:
        raise SystemExit(f"marking sheet {file_path} lists no tasks")

    tasks = tuple(_task(entry, file_path) for entry in tasks_raw)
    numbers = [task.number for task in tasks]
    if len(set(numbers)) != len(numbers):
        raise SystemExit(f"marking sheet {file_path} repeats a task number")

    return MarkingSheet(
        version=str(data.get("version") or file_path.stem),
        path=file_path,
        sha256=hashlib.sha256(raw_bytes).hexdigest(),
        derived_from=dict(data.get("derived_from") or {}),
        tasks=tasks,
    )


def _task(entry: Any, file_path: Path) -> TaskSheet:
    if not isinstance(entry, dict):
        raise SystemExit(f"marking sheet {file_path} has a task that is not a mapping")
    try:
        number = int(entry["number"])
    except (KeyError, TypeError, ValueError):
        raise SystemExit(f"marking sheet {file_path} has a task with no usable number") from None

    points_raw = entry.get("points")
    if not isinstance(points_raw, list) or not points_raw:
        raise SystemExit(f"marking sheet {file_path}: task {number} lists no points")
    points = tuple(_point(point, number, file_path) for point in points_raw)
    ids = [point.id for point in points]
    if len(set(ids)) != len(ids):
        raise SystemExit(f"marking sheet {file_path}: task {number} repeats a point id")

    return TaskSheet(
        number=number,
        title=str(entry.get("title") or ""),
        points=points,
        live_pages=tuple(str(url) for url in entry.get("live_pages") or ()),
    )


def _point(entry: Any, task_number: int, file_path: Path) -> Point:
    where = f"marking sheet {file_path}: task {task_number}"
    if not isinstance(entry, dict):
        raise SystemExit(f"{where} has a point that is not a mapping")
    unknown = set(entry) - _POINT_KEYS
    if unknown:
        raise SystemExit(f"{where} point {entry.get('id')!r} has unknown keys: {sorted(unknown)}")

    point_id = str(entry.get("id") or "").strip()
    if not point_id:
        raise SystemExit(f"{where} has a point with no id")

    checks = tuple(str(check) for check in entry.get("checks") or ())
    if not checks or set(checks) - _VALID_CHECKS:
        raise SystemExit(
            f"{where} point {point_id} must set checks to one or both of 'code' and 'judge'; "
            f"got {list(checks)}"
        )

    groups = []
    for group in entry.get("required_strings") or ():
        alternatives = tuple(str(item) for item in group) if isinstance(group, list) else (str(group),)
        if not alternatives:
            raise SystemExit(f"{where} point {point_id} has an empty required_strings group")
        groups.append(alternatives)

    point = Point(
        id=point_id,
        text=str(entry.get("text") or "").strip(),
        checks=checks,
        citation_allowlist=tuple(str(item) for item in entry.get("citation_allowlist") or ()),
        citation_mechanics=bool(entry.get("citation_mechanics")),
        citation_hosts=tuple(str(item).lower() for item in entry.get("citation_hosts") or ()),
        required_strings=tuple(groups),
        requires_justification=bool(entry.get("requires_justification")),
    )

    # A code-checked point with nothing for the code pass to check would silently mark itself.
    if point.code_checked and not (
        point.citation_allowlist or point.citation_mechanics or point.required_strings
    ):
        raise SystemExit(
            f"{where} point {point_id} is code-checked but names no citation rule or required "
            "string for the code pass to check"
        )
    return point
