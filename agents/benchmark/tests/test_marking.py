# ABOUTME: Tests for the code pass: reading a run, parsing its Sources list, and marking the
# points a sheet can settle without a model.
#
# No network and no model: the transport is injected and answers from a table.

from __future__ import annotations

import pytest

from benchmark.marking import (
    AWARDED,
    NOT_CODE_CHECKED,
    REFUSED,
    load_run,
    parse_sources,
    resolve_citations,
    run_code_pass,
)
from benchmark.marking_sheet import load_sheet


def _verdicts(results):
    return {result.point_id: result.verdict for result in results}


async def _code_pass(run_dir, sheet_file, transport):
    run = load_run(run_dir)[0]
    urls, found = parse_sources(run.answer)
    citations = await resolve_citations(urls, run.fetch_log, transport)
    task_sheet = load_sheet(sheet_file).task(run.task_number)
    return run_code_pass(
        task_sheet=task_sheet, answer=run.answer, citations=citations, sources_found=found
    )


# -- the Sources list -------------------------------------------------------


@pytest.mark.parametrize(
    "answer",
    [
        "text\n\nSources\nhttps://docs.temporal.io/quickstarts\n",
        "text\n\n## Sources\n- https://docs.temporal.io/quickstarts\n",
        "text\n\n### Sources\n* <https://docs.temporal.io/quickstarts>\n",
        "text\n\n**Sources:**\n1. https://docs.temporal.io/quickstarts.\n",
        "text\n\nSources\n[quickstarts](https://docs.temporal.io/quickstarts)\n",
    ],
)
def test_it_reads_the_sources_list_however_it_is_written(answer):
    urls, found = parse_sources(answer)
    assert found and urls == ["https://docs.temporal.io/quickstarts"]


def test_a_url_quoted_in_the_prose_is_not_a_citation():
    urls, found = parse_sources("see https://docs.temporal.io/quickstarts for more\n")
    assert (urls, found) == ([], False)


def test_duplicates_are_dropped_and_order_is_kept():
    answer = "Sources\nhttps://a.io/one\nhttps://b.io/two\nhttps://a.io/one\n"
    assert parse_sources(answer)[0] == ["https://a.io/one", "https://b.io/two"]


# -- reading a run ----------------------------------------------------------


def test_it_reads_a_run_directory(make_run):
    run = load_run(make_run())[0]
    assert run.task_number == 1
    assert len(run.fetch_log) == 2
    assert "temporal server start-dev" in run.answer


def test_a_directory_that_is_not_a_run_is_refused(tmp_path):
    with pytest.raises(SystemExit) as caught:
        load_run(tmp_path)
    assert "not a benchmark run directory" in str(caught.value)


# -- the pass ---------------------------------------------------------------


async def test_every_cited_url_served_and_resolving_awards_the_citation_points(
    make_run, sheet_file, transport
):
    code_pass = await _code_pass(make_run(), sheet_file, transport())
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.1"] == AWARDED
    assert verdicts["1.3"] == AWARDED
    assert verdicts["1.4"] == AWARDED
    assert verdicts["1.2"] == NOT_CODE_CHECKED
    assert all(citation.sound for citation in code_pass.citations)


async def test_a_cited_url_the_run_never_fetched_loses_the_mechanics_point(
    make_run, sheet_file, transport
):
    run_dir = make_run(fetched=("https://docs.temporal.io/quickstarts",))
    code_pass = await _code_pass(run_dir, sheet_file, transport())
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.3"] == REFUSED
    # The allowlisted URL was fetched, so the point that names it survives.
    assert verdicts["1.1"] == AWARDED
    unfetched = [c for c in code_pass.citations if not c.served_in_run]
    assert [c.url for c in unfetched] == [
        "https://docs.temporal.io/develop/python/set-up-your-local-python"
    ]
    assert any("not served in the run" in reason for reason in code_pass.points[2].reasons)


async def test_a_url_refused_during_the_run_does_not_count_as_served(
    make_run, sheet_file, transport
):
    run_dir = make_run(
        fetched=("https://docs.temporal.io/develop/python/set-up-your-local-python",),
        refused=("https://docs.temporal.io/quickstarts",),
    )
    code_pass = await _code_pass(run_dir, sheet_file, transport())
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.1"] == REFUSED and verdicts["1.3"] == REFUSED
    refused = next(c for c in code_pass.citations if c.url.endswith("quickstarts"))
    assert refused.attempted_in_run and not refused.served_in_run
    assert refused.run_refusal_reason == "route-refuses-markdown"


async def test_a_citation_outside_the_allowed_list_refuses_that_point(
    make_run, sheet_file, transport
):
    answer = (
        "Install the CLI and run `temporal server start-dev`.\n\nSources\n"
        "https://docs.temporal.io/dev-guide/python\n"
    )
    run_dir = make_run(answer=answer, fetched=("https://docs.temporal.io/dev-guide/python",))
    code_pass = await _code_pass(run_dir, sheet_file, transport())
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.1"] == REFUSED
    assert verdicts["1.3"] == AWARDED  # it resolves and was fetched; it is simply the wrong page
    assert any("allowed list" in reason for reason in code_pass.points[0].reasons)


async def test_a_citation_that_no_longer_resolves_is_recorded_as_such(
    make_run, sheet_file, transport
):
    checker = transport({"https://docs.temporal.io/quickstarts": 404})
    code_pass = await _code_pass(make_run(), sheet_file, checker)
    assert _verdicts(code_pass.points)["1.3"] == REFUSED
    gone = next(c for c in code_pass.citations if c.url.endswith("quickstarts"))
    assert gone.served_in_run and gone.live_status == 404 and not gone.resolves


async def test_an_unreachable_citation_is_an_error_not_a_crash(make_run, sheet_file, transport):
    checker = transport({"https://docs.temporal.io/quickstarts": 0})
    code_pass = await _code_pass(make_run(), sheet_file, checker)
    gone = next(c for c in code_pass.citations if c.url.endswith("quickstarts"))
    assert "ConnectionError" in gone.live_error and not gone.resolves


async def test_a_missing_required_string_refuses_its_point(make_run, sheet_file, transport):
    answer = (
        "Just deploy it to the cloud.\n\nSources\nhttps://docs.temporal.io/quickstarts\n"
        "https://docs.temporal.io/develop/python/set-up-your-local-python\n"
    )
    code_pass = await _code_pass(make_run(answer=answer), sheet_file, transport())
    assert _verdicts(code_pass.points)["1.4"] == REFUSED


async def test_an_answer_with_no_sources_list_loses_the_citation_points(
    make_run, sheet_file, transport
):
    code_pass = await _code_pass(
        make_run(answer="Run `temporal server start-dev`.\n"), sheet_file, transport()
    )
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.1"] == REFUSED and verdicts["1.3"] == REFUSED
    assert not code_pass.sources_section_found
