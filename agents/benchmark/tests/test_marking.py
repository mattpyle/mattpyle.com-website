# ABOUTME: Tests for the code pass: reading a run, parsing its Sources list, and marking the
# points a sheet can settle without a model.
#
# No network and no model: the transport is injected and answers from a table. Every URL here is
# invented, like the fixtures behind it.

from __future__ import annotations

import pytest

from benchmark.marking import (
    AWARDED,
    MAX_CITATIONS_CHECKED,
    NOT_CODE_CHECKED,
    REFUSED,
    load_run,
    parse_sources,
    resolve_citations,
    run_code_pass,
)
from benchmark.marking_sheet import load_sheet
from tests.conftest import DOCS


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
        f"text\n\nSources\n{DOCS}/start\n",
        f"text\n\n## Sources\n- {DOCS}/start\n",
        f"text\n\n### Sources\n* <{DOCS}/start>\n",
        f"text\n\n**Sources:**\n1. {DOCS}/start.\n",
        f"text\n\nSources\n[start here]({DOCS}/start)\n",
    ],
)
def test_it_reads_the_sources_list_however_it_is_written(answer):
    urls, found = parse_sources(answer)
    assert found and urls == [f"{DOCS}/start"]


def test_a_url_quoted_in_the_prose_is_not_a_citation():
    urls, found = parse_sources(f"see {DOCS}/start for more\n")
    assert (urls, found) == ([], False)


def test_duplicates_are_dropped_and_order_is_kept():
    answer = "Sources\nhttps://a.example/one\nhttps://b.example/two\nhttps://a.example/one\n"
    assert parse_sources(answer)[0] == ["https://a.example/one", "https://b.example/two"]


# -- reading a run ----------------------------------------------------------


def test_it_reads_a_run_directory(make_run):
    run = load_run(make_run())[0]
    assert run.task_number == 1
    assert len(run.fetch_log) == 2
    assert "nimbus daemon start" in run.answer


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
    run_dir = make_run(fetched=(f"{DOCS}/start",))
    code_pass = await _code_pass(run_dir, sheet_file, transport())
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.3"] == REFUSED
    # The allowlisted URL was fetched, so the point that names it survives.
    assert verdicts["1.1"] == AWARDED
    unfetched = [c for c in code_pass.citations if not c.served_in_run]
    assert [c.url for c in unfetched] == [f"{DOCS}/guide/first-project"]
    assert any("not served in the run" in reason for reason in code_pass.points[2].reasons)


async def test_a_url_refused_during_the_run_does_not_count_as_served(
    make_run, sheet_file, transport
):
    run_dir = make_run(fetched=(f"{DOCS}/guide/first-project",), refused=(f"{DOCS}/start",))
    code_pass = await _code_pass(run_dir, sheet_file, transport())
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.1"] == REFUSED and verdicts["1.3"] == REFUSED
    refused = next(c for c in code_pass.citations if c.url.endswith("/start"))
    assert refused.attempted_in_run and not refused.served_in_run
    assert refused.run_refusal_reason == "route-refuses-markdown"


async def test_a_citation_outside_the_allowed_list_refuses_that_point(
    make_run, sheet_file, transport
):
    answer = f"Run `nimbus daemon start`.\n\nSources\n{DOCS}/reference/api\n"
    run_dir = make_run(answer=answer, fetched=(f"{DOCS}/reference/api",))
    code_pass = await _code_pass(run_dir, sheet_file, transport())
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.1"] == REFUSED
    assert verdicts["1.3"] == AWARDED  # it resolves and was fetched; it is simply the wrong page
    assert any("allowed list" in reason for reason in code_pass.points[0].reasons)


async def test_the_allowed_list_matches_a_prefix_and_not_a_substring(
    make_run, sheet_file, transport
):
    """`attacker.example/docs.nimbus.example/start` must not pass for the page it names."""
    forged = "https://attacker.example/docs.nimbus.example/start"
    answer = f"Run `nimbus daemon start`.\n\nSources\n{forged}\n"
    code_pass = await _code_pass(
        make_run(answer=answer, fetched=(forged,)), sheet_file, transport()
    )
    assert _verdicts(code_pass.points)["1.1"] == REFUSED


async def test_the_allowed_list_accepts_the_markdown_twin_of_the_page_it_names(
    make_run, sheet_file, transport
):
    """Route C is served `start.md` where route A reads `start`; both cite the same page."""
    answer = f"Run `nimbus daemon start`.\n\nSources\n{DOCS}/start.md\n"
    code_pass = await _code_pass(
        make_run(answer=answer, fetched=(f"{DOCS}/start.md",)), sheet_file, transport()
    )
    assert _verdicts(code_pass.points)["1.1"] == AWARDED


async def test_a_citation_that_no_longer_resolves_is_recorded_as_such(
    make_run, sheet_file, transport
):
    checker = transport({f"{DOCS}/start": 404})
    code_pass = await _code_pass(make_run(), sheet_file, checker)
    assert _verdicts(code_pass.points)["1.3"] == REFUSED
    gone = next(c for c in code_pass.citations if c.url.endswith("/start"))
    assert gone.served_in_run and gone.live_status == 404 and not gone.resolves


async def test_an_unreachable_citation_is_an_error_not_a_crash(make_run, sheet_file, transport):
    checker = transport({f"{DOCS}/start": 0})
    code_pass = await _code_pass(make_run(), sheet_file, checker)
    gone = next(c for c in code_pass.citations if c.url.endswith("/start"))
    assert "ConnectionError" in gone.live_error and not gone.resolves


async def test_a_missing_required_string_refuses_its_point(make_run, sheet_file, transport):
    answer = f"Just run it in the cloud.\n\nSources\n{DOCS}/start\n{DOCS}/guide/first-project\n"
    code_pass = await _code_pass(make_run(answer=answer), sheet_file, transport())
    assert _verdicts(code_pass.points)["1.4"] == REFUSED


async def test_an_answer_with_no_sources_list_loses_the_citation_points(
    make_run, sheet_file, transport
):
    code_pass = await _code_pass(
        make_run(answer="Run `nimbus daemon start`.\n"), sheet_file, transport()
    )
    verdicts = _verdicts(code_pass.points)
    assert verdicts["1.1"] == REFUSED and verdicts["1.3"] == REFUSED
    assert not code_pass.sources_section_found


# -- what the marker will and will not fetch --------------------------------
#
# The Sources list is model output, so it is a list of requests a stranger asked the marker to
# make. These hold the bounds on that.


async def test_only_the_first_citations_of_a_long_list_are_fetched(transport):
    urls = [f"https://a.example/{index}" for index in range(MAX_CITATIONS_CHECKED + 5)]
    checker = transport()
    citations = await resolve_citations(urls, [], checker)
    assert len(checker.urls) == MAX_CITATIONS_CHECKED
    over = citations[MAX_CITATIONS_CHECKED:]
    assert all(c.skipped_reason and "cap" in c.skipped_reason for c in over)
    assert not any(c.resolves for c in over)


@pytest.mark.parametrize(
    "url",
    [
        "http://docs.nimbus.example/start",
        "ftp://docs.nimbus.example/start",
        "https://127.0.0.1/admin",
        "https://169.254.169.254/latest/meta-data/",
        "https://[::1]/admin",
        "https://10.0.0.5/internal",
    ],
)
async def test_a_url_the_marker_will_not_follow_is_recorded_with_its_reason(url, transport):
    checker = transport()
    citation = (await resolve_citations([url], [], checker))[0]
    assert checker.urls == []
    assert citation.skipped_reason and not citation.resolves


async def test_a_skipped_citation_still_refuses_the_mechanics_point(
    make_run, sheet_file, transport
):
    answer = f"Run `nimbus daemon start`.\n\nSources\n{DOCS}/start\nhttp://127.0.0.1/admin\n"
    code_pass = await _code_pass(
        make_run(answer=answer, fetched=(f"{DOCS}/start", "http://127.0.0.1/admin")),
        sheet_file,
        transport(),
    )
    assert _verdicts(code_pass.points)["1.3"] == REFUSED
