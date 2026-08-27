# ABOUTME: Marks run directories against the marking sheet and writes each run's marking.json.
#
# Two passes in one command: the code pass, which is deterministic and always runs, then one blind
# judge call per task per run. Named more than one run directory, it also writes the calibration
# summary table — every answer, every point, the judge's call — and prints the total judge cost,
# which is the number the judge audition's kill rule needs.
#
#     uv run benchmark-mark runs\2026-08-24-a runs\2026-08-24-b --summary calibration.md

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

from .envfile import load_env_file
from .fetch import Transport
from .judge import (
    JudgeResult,
    JudgeVerdict,
    call_judge,
    default_judge_prompt_path,
    load_judge_prompt,
    normalise_point_id,
    render_judge_input,
)
from .marking import (
    AWARDED,
    NOT_CODE_CHECKED,
    RunArtifacts,
    fetch_live_pages,
    load_run,
    marking_transport,
    parse_sources,
    resolve_citations,
    run_code_pass,
)
from .marking_sheet import MarkingSheet, default_sheet_path, load_sheet
from .runtime import DEFAULT_MODEL, provider_key_problem
from .task_pack import load_task

MARKING_SCHEMA = "benchmark-marking/1"

# Cheap by default, so nobody discovers the expensive judge by forgetting a flag. The audition
# passes `--judge-model` explicitly and reports what it cost.
DEFAULT_JUDGE_MODEL = DEFAULT_MODEL


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="benchmark-mark",
        description="Mark one or more benchmark run directories against the marking sheet.",
    )
    parser.add_argument("run_dirs", nargs="+", type=Path, help="run directories to mark")
    parser.add_argument("--task", type=int, default=None, help="mark only this task in each run")
    parser.add_argument(
        "--sheet", type=Path, default=None, help="path to the marking sheet file"
    )
    parser.add_argument(
        "--judge-prompt", type=Path, default=None, help="path to the judge prompt template"
    )
    parser.add_argument(
        "--judge-model",
        default=DEFAULT_JUDGE_MODEL,
        help="model that marks the judge-checked points (default: %(default)s)",
    )
    parser.add_argument("--pack", type=Path, default=None, help="path to the task pack markdown")
    parser.add_argument(
        "--no-judge",
        action="store_true",
        help="run the code pass only; marking.json records no judge verdicts",
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=None,
        help="write the per-answer, per-point summary table here (calibration mode)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    load_env_file()
    args = _parse_args(argv)

    if not args.no_judge:
        problem = provider_key_problem(args.judge_model)
        if problem:
            print(f"error: {problem}", file=sys.stderr)
            return 2

    sheet = load_sheet(args.sheet or default_sheet_path())
    prompt = None if args.no_judge else load_judge_prompt(args.judge_prompt or default_judge_prompt_path())

    return asyncio.run(_mark_all(args=args, sheet=sheet, prompt=prompt))


async def _mark_all(*, args, sheet: MarkingSheet, prompt, transport: Transport = marking_transport) -> int:
    markings: list[dict] = []
    total_cost = 0.0
    priced = True

    for run_dir in args.run_dirs:
        for run in load_run(run_dir, args.task):
            marking = await mark_run(
                run=run,
                sheet=sheet,
                prompt=prompt,
                judge_model=args.judge_model,
                pack_path=args.pack,
                transport=transport,
                judge=call_judge,
            )
            path = run.run_dir / f"task-{run.task_number}-marking.json"
            path.write_text(
                json.dumps(marking, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
            )
            markings.append(marking)
            score = marking["score"]
            print(
                f"{run.name} task {run.task_number}: "
                f"{score['awarded']}/{score['of']} awarded, "
                f"{score['unresolved']} unresolved -> {path.name}",
                flush=True,
            )
            if marking["unmatched_verdicts"]:
                ids = ", ".join(repr(v["id"]) for v in marking["unmatched_verdicts"])
                print(
                    f"  warning: judge returned {len(marking['unmatched_verdicts'])} verdict(s) "
                    f"for no point on this sheet: {ids}",
                    flush=True,
                )
            cost = (marking["judge"] or {}).get("cost_usd")
            if cost is None and not args.no_judge:
                priced = False
            total_cost += cost or 0.0

    table = summary_table(markings)
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(table, encoding="utf-8")
        print(f"\nsummary table -> {args.summary}", flush=True)
    elif len(markings) > 1:
        print("\n" + table, flush=True)

    if not args.no_judge:
        suffix = "" if priced else " (some calls could not be priced)"
        print(f"\ntotal judge cost: ${total_cost:.4f}{suffix}", flush=True)
    return 0


async def mark_run(
    *,
    run: RunArtifacts,
    sheet: MarkingSheet,
    prompt,
    judge_model: str,
    pack_path: Path | None,
    transport: Transport,
    judge,
) -> dict:
    """Mark one task of one run and return the marking transcript."""
    task_sheet = sheet.task(run.task_number)
    urls, sources_found = parse_sources(run.answer)
    citations = await resolve_citations(urls, run.fetch_log, transport)
    code_pass = run_code_pass(
        task_sheet=task_sheet,
        answer=run.answer,
        citations=citations,
        sources_found=sources_found,
    )
    live_pages = await fetch_live_pages(task_sheet.live_pages, transport)

    judge_input = ""
    judge_result: JudgeResult | None = None
    if prompt is not None:
        task = load_task(run.task_number, pack_path)
        judge_input = render_judge_input(
            prompt=prompt,
            task_prompt=task.prompt,
            task_sheet=task_sheet,
            answer=run.answer,
            code_pass=code_pass,
            live_pages=live_pages,
        )
        try:
            judge_result = await judge(judge_model, judge_input)
        except Exception as exc:  # noqa: BLE001 - a failed judge call is a recorded outcome
            judge_result = JudgeResult(error=f"{type(exc).__name__}: {exc}")

    # The judge writes ids back the way the prompt renders them, so `"Point 1.2"` and `"1.2"` are
    # the same point. Both sides of the join are normalised; see `normalise_point_id`. The first
    # verdict for a key wins and any later one is spare, so a judge that marks a point twice does
    # not quietly overwrite its own first answer.
    verdicts: dict[str, JudgeVerdict] = {}
    spare: list[JudgeVerdict] = []
    for verdict in judge_result.verdicts if judge_result else []:
        key = normalise_point_id(verdict.point_id)
        if key in verdicts:
            spare.append(verdict)
        else:
            verdicts[key] = verdict
    code_results = {result.point_id: result for result in code_pass.points}

    matched: set[str] = set()
    points = []
    for point in task_sheet.points:
        code = code_results[point.id]
        key = normalise_point_id(point.id)
        verdict = verdicts.get(key)
        if verdict is not None:
            matched.add(key)
        code_awarded = code.verdict == AWARDED if point.code_checked else None
        judge_awarded = verdict.awarded if verdict else None
        awarded = _combine(point.code_checked, point.judge_checked, code_awarded, judge_awarded)
        points.append(
            {
                "id": point.id,
                "text": point.text,
                "checks": list(point.checks),
                "awarded": awarded,
                "code": {
                    "verdict": code.verdict,
                    "reasons": code.reasons,
                }
                if point.code_checked
                else {"verdict": NOT_CODE_CHECKED, "reasons": []},
                "judge": verdict.as_dict() if verdict else None,
            }
        )

    awarded_count = sum(1 for point in points if point["awarded"] is True)
    unresolved = sum(1 for point in points if point["awarded"] is None)
    # A verdict for a point this sheet does not have is kept rather than dropped: a mark that
    # disappears is invisible, and the next id the judge invents has to be readable evidence.
    unmatched = [
        verdict.as_dict() for key, verdict in verdicts.items() if key not in matched
    ] + [verdict.as_dict() for verdict in spare]

    return {
        "schema": MARKING_SCHEMA,
        "run_dir": run.name,
        "task_number": run.task_number,
        "task_title": task_sheet.title,
        "marked_at": datetime.now().astimezone().isoformat(),
        "marking_sheet": sheet.identity(),
        "judge_prompt": prompt.identity() if prompt else None,
        "judge_model": judge_model if prompt else None,
        "judge": judge_result.as_dict() if judge_result else None,
        "judge_input": judge_input,
        "code_pass": code_pass.as_dict(),
        "live_pages": [
            {key: page[key] for key in ("url", "status", "truncated", "error")}
            for page in live_pages
        ],
        "points": points,
        "unmatched_verdicts": unmatched,
        "score": {"awarded": awarded_count, "of": len(points), "unresolved": unresolved},
    }


def _combine(
    code_checked: bool, judge_checked: bool, code_awarded: bool | None, judge_awarded: bool | None
) -> bool | None:
    """The code pass is never overridden: a point it refuses stays refused whatever the judge says."""
    if code_checked and code_awarded is False:
        return False
    if judge_checked:
        if judge_awarded is None:
            return None
        return bool(judge_awarded)
    return code_awarded


def summary_table(markings: list[dict]) -> str:
    """One table the architect can set beside Matt's hand marks."""
    lines = [
        "| Run | Task | Point | Checks | Code | Judge | Awarded | Justification |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for marking in markings:
        for point in marking["points"]:
            judge = point["judge"]
            judge_call = "-" if judge is None else ("awarded" if judge["awarded"] else "refused")
            justification = "" if judge is None else judge["justification"].replace("|", "\\|")
            lines.append(
                "| {run} | {task} | {point} | {checks} | {code} | {judge} | {awarded} | {why} |".format(
                    run=marking["run_dir"],
                    task=marking["task_number"],
                    point=point["id"],
                    checks="+".join(point["checks"]),
                    code=point["code"]["verdict"],
                    judge=judge_call,
                    awarded={True: "yes", False: "no", None: "unresolved"}[point["awarded"]],
                    why=justification,
                )
            )
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    raise SystemExit(main())
