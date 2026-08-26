# ABOUTME: Tests for what reaches the judge.
#
# The judge is blind by construction: it sees only what `render_judge_input` puts in front of it.
# These tests hold that property, and they never make a model call.

from __future__ import annotations

import pytest

from benchmark.judge import (
    estimate_cost,
    load_judge_prompt,
    render_judge_input,
    render_marking_sheet,
)
from benchmark.marking import load_run, parse_sources, resolve_citations, run_code_pass
from benchmark.marking_sheet import load_sheet

TEMPLATE = """\
<!-- a comment the marker keeps -->
Mark this answer.

## The question
{{task_prompt}}

## The points
{{marking_sheet}}

## Citations
{{citation_verdicts}}

## Pages at marking time
{{live_pages}}

## The answer
{{answer}}
"""


@pytest.fixture
def prompt_file(tmp_path):
    path = tmp_path / "judge-prompt.md"
    path.write_text(TEMPLATE, encoding="utf-8")
    return path


async def _rendered(run_dir, sheet_file, prompt_file, transport):
    run = load_run(run_dir)[0]
    urls, found = parse_sources(run.answer)
    citations = await resolve_citations(urls, run.fetch_log, transport)
    task_sheet = load_sheet(sheet_file).task(run.task_number)
    code_pass = run_code_pass(
        task_sheet=task_sheet, answer=run.answer, citations=citations, sources_found=found
    )
    return run, render_judge_input(
        prompt=load_judge_prompt(prompt_file),
        task_prompt="Help me get started with Temporal.",
        task_sheet=task_sheet,
        answer=run.answer,
        code_pass=code_pass,
        live_pages=[
            {
                "url": "https://docs.temporal.io/develop/python/set-up-your-local-python",
                "status": 200,
                "content_type": "text/html",
                "text": "brew install temporal",
                "truncated": False,
                "error": None,
            }
        ],
    )


async def test_the_judge_never_sees_the_route_the_model_or_the_run(
    make_run, sheet_file, prompt_file, transport
):
    run, rendered = await _rendered(make_run(), sheet_file, prompt_file, transport())
    # The run directory's own artifacts name all three; none of them may reach the judge.
    assert run.summary["model"] == "anthropic:claude-sonnet-5"
    for leak in (
        run.name,
        "anthropic:claude-sonnet-5",
        "claude",
        "HTML only",
        "route",
        "1344397",
        "1350911",
    ):
        assert leak.lower() not in rendered.lower(), f"{leak!r} reached the judge"


async def test_it_carries_the_answer_the_prompt_and_the_live_page(
    make_run, sheet_file, prompt_file, transport
):
    _, rendered = await _rendered(make_run(), sheet_file, prompt_file, transport())
    assert "Help me get started with Temporal." in rendered
    assert "temporal server start-dev" in rendered
    assert "brew install temporal" in rendered
    assert "fetched during the run" in rendered
    assert "{{" not in rendered


async def test_code_only_points_are_not_put_to_the_judge(
    make_run, sheet_file, prompt_file, transport
):
    _, rendered = await _rendered(make_run(), sheet_file, prompt_file, transport())
    # 1.1 and 1.3 are code-only; 1.2 and 1.4 are the judge's.
    assert "Point 1.2" in rendered and "Point 1.4" in rendered
    assert "Point 1.1" not in rendered and "Point 1.3" not in rendered


async def test_a_point_the_code_pass_shares_arrives_as_presence_already_settled(
    make_run, sheet_file, transport
):
    run = load_run(make_run())[0]
    urls, found = parse_sources(run.answer)
    citations = await resolve_citations(urls, run.fetch_log, transport())
    task_sheet = load_sheet(sheet_file).task(1)
    code_pass = run_code_pass(
        task_sheet=task_sheet, answer=run.answer, citations=citations, sources_found=found
    )
    rendered = render_marking_sheet(task_sheet, code_pass)
    assert "Code pass (presence only, already settled): awarded" in rendered
    assert "correctness, not presence" in rendered


def test_a_template_missing_a_placeholder_is_refused(tmp_path):
    path = tmp_path / "broken.md"
    path.write_text("{{answer}} only\n", encoding="utf-8")
    with pytest.raises(SystemExit) as caught:
        load_judge_prompt(path)
    assert "task_prompt" in str(caught.value)


def test_the_prompt_identity_it_records_names_the_file(prompt_file):
    identity = load_judge_prompt(prompt_file).identity()
    assert identity["path"] == str(prompt_file) and len(identity["sha256"]) == 64


def test_cost_is_priced_from_the_token_counts():
    cost = estimate_cost(
        "deepseek:deepseek-v4-flash", {"input_tokens": 10_000, "output_tokens": 2_000}
    )
    assert cost is not None and cost > 0


def test_an_unpriced_model_costs_none_rather_than_nothing():
    assert estimate_cost("nowhere:no-such-model", {"input_tokens": 10, "output_tokens": 1}) is None
