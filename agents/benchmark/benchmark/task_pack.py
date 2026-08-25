# ABOUTME: Reads one task prompt out of the frozen task pack at runtime.
#
# The pack is private working material and its prompts are never embedded in this repository's
# committed code: the rig is given a path and reads the file when it runs. This module extracts
# ONLY the prompt line for the requested task. The marking sheet that follows it is deliberately
# not read, so there is no path by which it could reach the agent.

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

__all__ = ["Task", "load_task", "default_pack_path"]

_HEADING = re.compile(r"^##\s+Task\s+(\d+)\s*:\s*(.+?)\s*$")
_PROMPT = re.compile(r'^\*\*Prompt:\*\*\s*"(.+)"\s*$')

# The pack path, relative to the repository root, when the environment does not name one.
PACK_RELATIVE_PATH = "docs/reference/benchmark-task-pack-temporal-v1.md"


@dataclass(frozen=True)
class Task:
    number: int
    title: str
    prompt: str


def default_pack_path() -> Path:
    """Where to look for the pack: `BENCHMARK_TASK_PACK` if set, else the vault copy in this
    repository (this file sits at `agents/benchmark/benchmark/task_pack.py`)."""
    from_env = os.environ.get("BENCHMARK_TASK_PACK")
    if from_env:
        return Path(from_env).expanduser()
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / PACK_RELATIVE_PATH


def load_task(number: int, pack_path: Path | None = None) -> Task:
    """Return the prompt for one task, and nothing else from its section."""
    path = pack_path or default_pack_path()
    if not path.is_file():
        raise SystemExit(
            f"task pack not found at {path}. Set BENCHMARK_TASK_PACK to its location."
        )

    current: tuple[int, str] | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        heading = _HEADING.match(line)
        if heading:
            current = (int(heading.group(1)), heading.group(2))
            continue
        if current is None or current[0] != number:
            continue
        prompt = _PROMPT.match(line)
        if prompt:
            return Task(number=current[0], title=current[1], prompt=prompt.group(1))

    raise SystemExit(f"task {number} has no prompt line in {path}")
