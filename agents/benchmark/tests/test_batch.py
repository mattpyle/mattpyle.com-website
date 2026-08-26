# ABOUTME: Tests for the batch runner's plan, its manifest, and resume.
#
# The runner is injected, so these execute no runs, start no worker and reach no server. What is
# under test is the bookkeeping: which cells are still owed, and what a killed batch resumes from.

from __future__ import annotations

import json
from pathlib import Path

from benchmark.batch_cli import (
    Cell,
    CellOutcome,
    execute,
    load_manifest,
    pending_cells,
    plan_cells,
)


def _runner(outcomes: dict[str, CellOutcome] | None = None):
    seen: list[str] = []

    def run(cell: Cell) -> CellOutcome:
        seen.append(cell.key)
        return (outcomes or {}).get(
            cell.key, CellOutcome(status="ok", exit_code=0, run_dir=f"run-{cell.key}")
        )

    run.seen = seen  # type: ignore[attr-defined]
    return run


def test_the_plan_is_every_task_route_and_repeat():
    cells = plan_cells([1, 2], ["a", "b", "c"], 5)
    assert len(cells) == 30
    assert cells[0].key == "1/a/1" and cells[-1].key == "2/c/5"


def test_everything_is_pending_against_an_empty_manifest():
    cells = plan_cells([1], ["a"], 2)
    assert [cell.key for cell in pending_cells(cells, {})] == ["1/a/1", "1/a/2"]


def test_a_recorded_cell_is_not_pending():
    cells = plan_cells([1], ["a"], 2)
    manifest = {"cells": [{"key": "1/a/1", "status": "ok"}]}
    assert [cell.key for cell in pending_cells(cells, manifest)] == ["1/a/2"]


def test_a_failure_is_an_outcome_and_stays_recorded():
    cells = plan_cells([1], ["a"], 1)
    manifest = {"cells": [{"key": "1/a/1", "status": "failed"}]}
    assert pending_cells(cells, manifest) == []
    assert [cell.key for cell in pending_cells(cells, manifest, retry_failed=True)] == ["1/a/1"]


def test_a_batch_runs_every_cell_and_writes_its_manifest(tmp_path: Path):
    manifest: dict = {"cells": []}
    path = tmp_path / "batch.json"
    runner = _runner()
    assert execute(plan_cells([1], ["a", "b"], 1), manifest=manifest, manifest_path=path, runner=runner) == 0
    assert runner.seen == ["1/a/1", "1/b/1"]
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert {cell["key"] for cell in saved["cells"]} == {"1/a/1", "1/b/1"}
    assert saved["cells"][0]["run_dir"] == "run-1/a/1"
    assert saved["updated_at"]


def test_rerunning_a_finished_batch_executes_nothing(tmp_path: Path):
    manifest: dict = {"cells": []}
    path = tmp_path / "batch.json"
    cells = plan_cells([1], ["a"], 2)
    execute(cells, manifest=manifest, manifest_path=path, runner=_runner())

    reloaded = load_manifest(path)
    again = _runner()
    assert pending_cells(cells, reloaded) == []
    assert execute(pending_cells(cells, reloaded), manifest=reloaded, manifest_path=path, runner=again) == 0
    assert again.seen == []


def test_a_failing_cell_does_not_abort_the_batch(tmp_path: Path):
    manifest: dict = {"cells": []}
    path = tmp_path / "batch.json"
    runner = _runner({"1/a/1": CellOutcome(status="failed", exit_code=1, run_dir="run-dead")})
    exit_code = execute(
        plan_cells([1], ["a"], 3), manifest=manifest, manifest_path=path, runner=runner
    )
    assert runner.seen == ["1/a/1", "1/a/2", "1/a/3"]
    assert exit_code == 1
    statuses = {cell["key"]: cell["status"] for cell in manifest["cells"]}
    assert statuses == {"1/a/1": "failed", "1/a/2": "ok", "1/a/3": "ok"}


def test_a_runner_that_raises_is_recorded_as_a_failure(tmp_path: Path):
    def explode(cell: Cell) -> CellOutcome:
        raise RuntimeError("the worker died")

    manifest: dict = {"cells": []}
    path = tmp_path / "batch.json"
    assert execute(plan_cells([1], ["a"], 1), manifest=manifest, manifest_path=path, runner=explode) == 1
    assert "the worker died" in manifest["cells"][0]["error"]


def test_a_half_finished_batch_resumes_from_where_it_stopped(tmp_path: Path):
    cells = plan_cells([1], ["a", "b"], 2)
    manifest: dict = {"cells": []}
    path = tmp_path / "batch.json"
    execute(cells[:2], manifest=manifest, manifest_path=path, runner=_runner())

    reloaded = load_manifest(path)
    resumed = _runner()
    execute(
        pending_cells(cells, reloaded), manifest=reloaded, manifest_path=path, runner=resumed
    )
    assert resumed.seen == ["1/b/1", "1/b/2"]
    assert len(load_manifest(path)["cells"]) == 4


# -- the plan a resumed batch runs under ------------------------------------


def _args(**overrides):
    from benchmark.batch_cli import _parse_args

    argv: list[str] = []
    for name, value in overrides.items():
        argv += [f"--{name.replace('_', '-')}", str(value)]
    return _parse_args(argv)


def test_a_fresh_batch_plans_the_whole_benchmark(monkeypatch):
    monkeypatch.delenv("BENCHMARK_MODEL", raising=False)
    from benchmark.batch_cli import DEFAULT_MODEL, resolve_plan

    plan, notes = resolve_plan(_args(), {})
    assert plan["tasks"] == [1, 2, 3, 4, 5]
    assert plan["routes"] == ["a", "b", "c"]
    assert plan["repeats"] == 5
    assert plan["model"] == DEFAULT_MODEL
    assert notes == []


def test_a_resumed_batch_keeps_the_model_and_flags_it_started_with(monkeypatch):
    monkeypatch.setenv("BENCHMARK_MODEL", "google:gemini-3.5-flash")
    from benchmark.batch_cli import resolve_plan

    manifest = {
        "plan": {
            "tasks": [1],
            "routes": ["c"],
            "repeats": 2,
            "model": "deepseek:deepseek-v4-flash",
            "run_flags": ["--token-budget", "500000"],
        }
    }
    plan, notes = resolve_plan(_args(), manifest)
    assert plan == manifest["plan"]
    assert notes == []


def test_changing_the_model_or_the_flags_mid_batch_is_said_out_loud():
    from benchmark.batch_cli import resolve_plan

    manifest = {
        "plan": {
            "tasks": [1],
            "routes": ["c"],
            "repeats": 2,
            "model": "deepseek:deepseek-v4-flash",
            "run_flags": ["--token-budget", "500000"],
        }
    }
    plan, notes = resolve_plan(
        _args(model="google:gemini-3.5-flash", token_budget=100), manifest
    )
    assert plan["model"] == "google:gemini-3.5-flash"
    assert plan["run_flags"] == ["--token-budget", "100"]
    assert len(notes) == 2


def test_the_temporal_api_key_never_reaches_the_manifest():
    from benchmark.batch_cli import PASSTHROUGH, resolve_plan

    assert "--temporal-api-key" not in PASSTHROUGH
    plan, _ = resolve_plan(_args(temporal_api_key="a-secret"), {})
    assert "a-secret" not in json.dumps(plan)
