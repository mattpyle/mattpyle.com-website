# ABOUTME: Shared fixtures for the marking tests: a marking sheet, a run directory, and a
# transport that never touches the network.
#
# Nothing here reads the real task pack or the real marking sheet. The vault files are private
# working material; the tests exercise the code that reads them, against fixtures of the same
# shape.

from __future__ import annotations

import json
from pathlib import Path

import pytest

SHEET = """\
# fixture sheet
version: fixture-v1
derived_from:
  pack: fixtures/pack.md
  pack_version: v1
tasks:
  - number: 1
    title: first workflow
    live_pages:
      - https://docs.temporal.io/develop/python/set-up-your-local-python
    points:
      - id: "1.1"
        text: Points to an official getting-started path.
        checks: [code]
        citation_allowlist:
          - docs.temporal.io/quickstarts
      - id: "1.2"
        text: The setup steps are correct and local-first.
        checks: [judge]
      - id: "1.3"
        text: Citations resolve and appear in the fetch log.
        checks: [code]
        citation_mechanics: true
      - id: "1.4"
        text: Names the dev server command, used correctly.
        checks: [code, judge]
        required_strings:
          - - "temporal server start-dev"
"""

ANSWER = """\
Install the Temporal CLI and run `temporal server start-dev`, then run the sample workflow.

Sources
https://docs.temporal.io/quickstarts
https://docs.temporal.io/develop/python/set-up-your-local-python
"""

PACK = """\
## Task 1: first workflow

**Prompt:** "I'm a Python developer and I keep hearing about Temporal. Help me get started."

Marking sheet, one point each:

1. Points to an official getting-started path.
"""


@pytest.fixture
def sheet_file(tmp_path: Path) -> Path:
    path = tmp_path / "sheet.yaml"
    path.write_text(SHEET, encoding="utf-8")
    return path


@pytest.fixture
def pack_file(tmp_path: Path) -> Path:
    path = tmp_path / "pack.md"
    path.write_text(PACK, encoding="utf-8")
    return path


@pytest.fixture
def make_run(tmp_path: Path):
    """Build a run directory of the shape `benchmark-run` writes."""

    def build(
        *,
        name: str = "2026-08-24-a",
        answer: str = ANSWER,
        fetched: tuple[str, ...] = (
            "https://docs.temporal.io/quickstarts",
            "https://docs.temporal.io/develop/python/set-up-your-local-python",
        ),
        refused: tuple[str, ...] = (),
        task_number: int = 1,
    ) -> Path:
        run_dir = tmp_path / name
        run_dir.mkdir(parents=True, exist_ok=True)
        prefix = f"task-{task_number}"
        (run_dir / f"{prefix}-answer.md").write_text(answer, encoding="utf-8")
        lines = [
            json.dumps(
                {
                    "timestamp": "2026-08-25T05:02:29+00:00",
                    "route": "a",
                    "url": url,
                    "kind": "html",
                    "served": True,
                    "status": 200,
                    "refusal_reason": None,
                }
            )
            for url in fetched
        ] + [
            json.dumps(
                {
                    "timestamp": "2026-08-25T05:02:30+00:00",
                    "route": "a",
                    "url": url,
                    "kind": "markdown",
                    "served": False,
                    "status": None,
                    "refusal_reason": "route-refuses-markdown",
                }
            )
            for url in refused
        ]
        (run_dir / f"{prefix}-fetches.jsonl").write_text(
            "\n".join(lines) + ("\n" if lines else ""), encoding="utf-8"
        )
        (run_dir / f"{prefix}-run.json").write_text(
            json.dumps(
                {
                    "route": "a",
                    "route_label": "HTML only",
                    "task_number": task_number,
                    "model": "anthropic:claude-sonnet-5",
                    "tokens": {"input_tokens": 1344397, "total_tokens": 1350911},
                }
            ),
            encoding="utf-8",
        )
        return run_dir

    return build


@pytest.fixture
def transport():
    """A transport that answers from a table and records what it was asked for."""

    class Recording:
        def __init__(self, statuses: dict[str, int] | None = None, body: str = "page text"):
            self.statuses = statuses or {}
            self.body = body
            self.urls: list[str] = []

        async def __call__(self, url: str, headers: dict[str, str]):
            self.urls.append(url)
            status = self.statuses.get(url, 200)
            if status == 0:
                raise ConnectionError("no route to host")
            return status, "text/html", self.body

    return Recording
