# ABOUTME: Shared fixtures for the marking tests: a marking sheet, a run directory, and a
# transport that never touches the network.
#
# Everything here is invented. The real task pack and its marking sheets are private working
# material — pack rule 1 is that the agent is never told what a sheet checks, and this repository
# is public — so the fixtures describe a made-up product on a made-up domain, in the shape the
# real files have. What is under test is the code that reads such a file, not the file.

from __future__ import annotations

import json
from pathlib import Path

import pytest

DOCS = "https://docs.nimbus.example"

SHEET = """\
# fixture sheet: invented criteria for an invented product
version: fixture-v1
derived_from:
  pack: fixtures/pack.md
  pack_version: v1
tasks:
  - number: 1
    title: starting out
    live_pages:
      - https://docs.nimbus.example/start
    points:
      - id: "1.1"
        text: Points at the official getting-started page.
        checks: [code]
        citation_allowlist:
          - docs.nimbus.example/start
      - id: "1.2"
        text: The steps are correct and run on the reader's own machine.
        checks: [judge]
      - id: "1.3"
        text: Citations resolve and appear in the fetch log.
        checks: [code]
        citation_mechanics: true
      - id: "1.4"
        text: Names the command that starts the daemon, and uses it for what it is.
        checks: [code, judge]
        required_strings:
          - - "nimbus daemon start"
"""

ANSWER = f"""\
Install the Nimbus CLI, then run `nimbus daemon start` and open the sample project.

Sources
{DOCS}/start
{DOCS}/guide/first-project
"""

PACK = """\
## Task 1: starting out

**Prompt:** "I keep hearing about Nimbus and I want to try it on my laptop. Where do I begin?"

Marking sheet, one point each:

1. Points at the official getting-started page.
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
        fetched: tuple[str, ...] = (f"{DOCS}/start", f"{DOCS}/guide/first-project"),
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
                    "model": "someprovider:some-model-9",
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
