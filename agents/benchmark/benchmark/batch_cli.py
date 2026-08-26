# ABOUTME: Runs the whole benchmark: every task, every route, N repeats, one run at a time.
#
# Each cell is a separate `benchmark-run` process, because one process is one run: the fetch tool
# keeps its counters in memory and the route is set in the environment before the workflow module
# is imported. A failed cell is an outcome, not an abort — the manifest records it and the batch
# carries on. Pointed at an existing manifest, the batch executes only the cells that have none.
#
# Marking is a separate command. This one never calls a judge.
#
#     uv run benchmark-batch --repeats 5
#     uv run benchmark-batch --manifest runs\batch-2026-08-25-101500.json

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable

from .envfile import load_env_file
from .routes import ROUTES
from .runtime import DEFAULT_MODEL, provider_key_problem

MANIFEST_SCHEMA = "benchmark-batch/1"

DEFAULT_TASKS = (1, 2, 3, 4, 5)
DEFAULT_ROUTES = ("a", "b", "c")
DEFAULT_REPEATS = 5

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# The flags a cell inherits: everything that has to be identical across routes within one
# benchmark run, plus where to reach Temporal. `--model` is resolved separately because a resumed
# batch has to answer on the model its first cells used.
PASSTHROUGH = (
    "--pack",
    "--address",
    "--namespace",
    "--max-fetches",
    "--max-bytes",
    "--wall-seconds",
    "--token-budget",
    "--model-activity-seconds",
    "--thinking",
)


@dataclass(frozen=True)
class Cell:
    task: int
    route: str
    repeat: int

    @property
    def key(self) -> str:
        return f"{self.task}/{self.route}/{self.repeat}"


@dataclass
class CellOutcome:
    status: str
    exit_code: int | None = None
    run_dir: str | None = None
    error: str | None = None


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="benchmark-batch",
        description="Run the full benchmark sequentially and record every cell in a manifest.",
    )
    parser.add_argument("--tasks", default=None, help="comma-separated task numbers (default: 1-5)")
    parser.add_argument("--routes", default=None, help="comma-separated routes (default: a,b,c)")
    parser.add_argument(
        "--repeats", type=int, default=None, help=f"runs per cell (default: {DEFAULT_REPEATS})"
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="manifest to write, or an existing one to fill in the missing cells of",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=PROJECT_ROOT / "runs",
        help="directory run folders and the manifest are written under (default: ./runs)",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="also re-run cells the manifest records as failed (default: leave them as recorded)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the cells that would run, and run nothing"
    )
    parser.add_argument("--model", default=None, help="model that answers (passed to benchmark-run)")
    parser.add_argument(
        "--temporal-api-key",
        default=None,
        help=(
            "Temporal Cloud API key for every cell. Never written to the manifest, so a resumed "
            "batch takes it from the environment or from this flag again."
        ),
    )
    for flag in PASSTHROUGH:
        parser.add_argument(flag, default=None, help=f"passed through to benchmark-run ({flag})")
    return parser.parse_args(argv)


def _split(value: str | None, cast) -> tuple | None:
    if value is None:
        return None
    return tuple(cast(item.strip()) for item in value.split(",") if item.strip())


def plan_cells(tasks: Iterable[int], routes: Iterable[str], repeats: int) -> list[Cell]:
    """Every cell of the benchmark, in the order it will run: task, then route, then repeat."""
    return [
        Cell(task=task, route=route, repeat=repeat)
        for task in tasks
        for route in routes
        for repeat in range(1, repeats + 1)
    ]


def pending_cells(cells: Iterable[Cell], manifest: dict, retry_failed: bool = False) -> list[Cell]:
    """The cells with no recorded outcome.

    A failure is an outcome, so a failed cell is not retried by default: re-running it silently
    would turn a recorded result into a different one. `--retry-failed` asks for it explicitly.
    """
    recorded = {
        entry["key"]: entry for entry in manifest.get("cells", []) if entry.get("status")
    }
    pending = []
    for cell in cells:
        entry = recorded.get(cell.key)
        if entry is None or (retry_failed and entry.get("status") == "failed"):
            pending.append(cell)
    return pending


def resolve_plan(args, manifest: dict) -> tuple[dict, list[str]]:
    """What this pass will run, and anything the operator should know about it.

    A resumed batch keeps the plan its first cells ran under: the model and the budgets have to be
    identical across the cells of one benchmark run, so the manifest wins over a default. The
    command line still wins over the manifest, and says so, because a batch whose cells did not
    all run the same way is a result nobody can compare.
    """
    recorded = manifest.get("plan", {})
    notes: list[str] = []

    named_flags: list[str] = []
    for flag in PASSTHROUGH:
        value = getattr(args, flag.lstrip("-").replace("-", "_"), None)
        if value is not None:
            named_flags += [flag, str(value)]
    recorded_flags = list(recorded.get("run_flags") or [])
    # Naming no flags on a resume inherits the recorded ones, so that is not a mismatch. Naming
    # different ones is, and it is one whether or not the first pass recorded any: a first batch
    # that ran on defaults records an empty list, and a resume that sets a budget against it
    # changes the cells just as much as one that sets a different budget.
    if recorded and named_flags and named_flags != recorded_flags:
        notes.append(
            f"note: this pass sets {named_flags}; the manifest recorded "
            f"{recorded_flags or 'no run flags'}. The command line wins, so the cells of this "
            "batch did not all run under the same flags."
        )

    model = (
        args.model or recorded.get("model") or os.environ.get("BENCHMARK_MODEL") or DEFAULT_MODEL
    )
    if recorded and args.model and args.model != recorded.get("model"):
        notes.append(
            f"note: this pass answers on {args.model}; the manifest recorded "
            f"{recorded['model']}. The cells of this batch are not all from one model."
        )

    plan = {
        "tasks": list(_split(args.tasks, int) or recorded.get("tasks") or DEFAULT_TASKS),
        "routes": list(_split(args.routes, str) or recorded.get("routes") or DEFAULT_ROUTES),
        "repeats": int(args.repeats or recorded.get("repeats") or DEFAULT_REPEATS),
        "model": model,
        "run_flags": named_flags or recorded_flags,
    }
    return plan, notes


def load_manifest(path: Path) -> dict:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path} is not a batch manifest")
    return data


def write_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest["updated_at"] = datetime.now().astimezone().isoformat()
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def record(manifest: dict, cell: Cell, outcome: CellOutcome, started_at: str) -> dict:
    entry = {
        "key": cell.key,
        "task": cell.task,
        "route": cell.route,
        "repeat": cell.repeat,
        "status": outcome.status,
        "exit_code": outcome.exit_code,
        "run_dir": outcome.run_dir,
        "error": outcome.error,
        "started_at": started_at,
        "ended_at": datetime.now().astimezone().isoformat(),
    }
    cells = [item for item in manifest.get("cells", []) if item.get("key") != cell.key]
    cells.append(entry)
    manifest["cells"] = cells
    return entry


def run_cell_subprocess(
    cell: Cell, *, out_dir: Path, passthrough: list[str], env: dict[str, str] | None = None
) -> CellOutcome:
    """One cell as one `benchmark-run` process, with its output echoed as it happens.

    Anything secret reaches the child through `env`, never through argv: a command line is
    readable by every process on the machine, and `benchmark-run` reads `TEMPORAL_API_KEY` from
    its environment anyway.
    """
    command = [
        sys.executable,
        "-m",
        "benchmark.cli",
        "--task",
        str(cell.task),
        "--route",
        cell.route,
        "--out",
        str(out_dir),
        *passthrough,
    ]
    before = {path.name for path in out_dir.glob("*") if path.is_dir()}
    run_dir: str | None = None
    try:
        process = subprocess.Popen(
            command,
            cwd=str(PROJECT_ROOT),
            env={**os.environ, **(env or {})},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        return CellOutcome(status="failed", error=f"{type(exc).__name__}: {exc}")

    assert process.stdout is not None
    for line in process.stdout:
        print(f"    {line.rstrip()}", flush=True)
        marker = line.find("artifacts ")
        if marker >= 0:
            run_dir = Path(line[marker + len("artifacts ") :].strip()).name
    exit_code = process.wait()

    if run_dir is None:
        # The child prints its run directory, but a crash before that line still leaves one on
        # disk; the new directory is the cell's, because the batch runs one at a time.
        made = {path.name for path in out_dir.glob("*") if path.is_dir()} - before
        run_dir = sorted(made)[-1] if made else None

    return CellOutcome(
        status="ok" if exit_code == 0 else "failed", exit_code=exit_code, run_dir=run_dir
    )


def main(argv: list[str] | None = None) -> int:
    load_env_file()
    args = _parse_args(argv)

    manifest_path = args.manifest or (
        args.out / f"batch-{datetime.now().astimezone().strftime('%Y-%m-%d-%H%M%S')}.json"
    )
    manifest = load_manifest(manifest_path)

    plan, notes = resolve_plan(args, manifest)
    for note in notes:
        print(note, flush=True)

    key_problem = provider_key_problem(plan["model"])
    if key_problem:
        print(f"error: {key_problem}", file=sys.stderr)
        return 2

    unknown = [route for route in plan["routes"] if route not in ROUTES]
    if unknown:
        print(f"error: unknown route(s) {', '.join(unknown)}", file=sys.stderr)
        return 2

    # The Temporal API key is never written to the manifest and never put on a child's command
    # line: an artifact file is not a place for a secret, and neither is the process table. It
    # reaches each run through the environment, which is where `benchmark-run` reads it anyway.
    passthrough = ["--model", plan["model"], *plan["run_flags"]]
    cell_env = {} if args.temporal_api_key is None else {"TEMPORAL_API_KEY": args.temporal_api_key}

    cells = plan_cells(plan["tasks"], plan["routes"], plan["repeats"])
    todo = pending_cells(cells, manifest, args.retry_failed)

    manifest.setdefault("schema", MANIFEST_SCHEMA)
    manifest.setdefault("created_at", datetime.now().astimezone().isoformat())
    manifest["plan"] = plan
    manifest.setdefault("cells", [])

    print(
        f"batch: {len(cells)} cells ({len(plan['tasks'])} tasks x {len(plan['routes'])} routes x "
        f"{plan['repeats']} repeats), {len(todo)} to run, model {plan['model']}\n"
        f"manifest {manifest_path}",
        flush=True,
    )
    if args.dry_run:
        for cell in todo:
            print(f"  would run task {cell.task} route {cell.route} repeat {cell.repeat}")
        return 0

    write_manifest(manifest_path, manifest)
    return execute(
        todo,
        manifest=manifest,
        manifest_path=manifest_path,
        runner=lambda cell: run_cell_subprocess(
            cell, out_dir=args.out, passthrough=passthrough, env=cell_env
        ),
        total=len(cells),
    )


def execute(
    todo: list[Cell],
    *,
    manifest: dict,
    manifest_path: Path,
    runner: Callable[[Cell], CellOutcome],
    total: int | None = None,
) -> int:
    """Run the pending cells one at a time, saving the manifest after each.

    The manifest is written after every cell rather than at the end, so a batch killed halfway
    resumes from where it stopped instead of starting over.
    """
    failures = 0
    for index, cell in enumerate(todo, start=1):
        started_at = datetime.now().astimezone().isoformat()
        print(
            f"\n[{index}/{len(todo)}] task {cell.task} route {cell.route} repeat {cell.repeat}",
            flush=True,
        )
        try:
            outcome = runner(cell)
        except Exception as exc:  # noqa: BLE001 - a cell that blows up is a recorded failure
            outcome = CellOutcome(status="failed", error=f"{type(exc).__name__}: {exc}")
        entry = record(manifest, cell, outcome, started_at)
        write_manifest(manifest_path, manifest)
        if outcome.status != "ok":
            failures += 1
        print(f"  {entry['status']}: {entry['run_dir'] or entry['error'] or 'no run directory'}", flush=True)

    done = sum(1 for entry in manifest.get("cells", []) if entry.get("status") == "ok")
    print(
        f"\nbatch done: {done} ok, {failures} failed this pass, "
        f"{len(manifest.get('cells', []))}/{total if total is not None else len(todo)} cells recorded"
        f"\nmanifest {manifest_path}",
        flush=True,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
