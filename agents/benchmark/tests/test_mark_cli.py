# ABOUTME: Tests for the marking transcript and the calibration summary.
#
# The judge is a fake here: every one of these runs with no model call, so the shape of
# marking.json and the rule that the code pass is never overridden are both held offline.

from __future__ import annotations

import json

import pytest

from benchmark.judge import JudgePrompt, JudgeResult, JudgeVerdict, normalise_point_id
from benchmark.mark_cli import mark_run, summary_table
from benchmark.marking import load_run
from benchmark.marking_sheet import load_sheet
from tests.conftest import DOCS

TEMPLATE = (
    "{{task_prompt}}\n{{marking_sheet}}\n{{citation_verdicts}}\n{{live_pages}}\n{{answer}}\n"
)


@pytest.fixture
def prompt(tmp_path):
    path = tmp_path / "judge-prompt.md"
    path.write_text(TEMPLATE, encoding="utf-8")
    from benchmark.judge import load_judge_prompt

    return load_judge_prompt(path)


def fake_judge(awarded: dict[str, bool], usage: dict | None = None):
    async def judge(model: str, judge_input: str) -> JudgeResult:
        usage_dict = usage or {"input_tokens": 4000, "output_tokens": 300, "total_tokens": 4300}
        from benchmark.judge import estimate_cost

        return JudgeResult(
            verdicts=[
                JudgeVerdict(point_id=point_id, awarded=value, justification=f"because {point_id}")
                for point_id, value in awarded.items()
            ],
            usage=usage_dict,
            cost_usd=estimate_cost(model, usage_dict),
        )

    return judge


async def _mark(run_dir, sheet_file, pack_file, prompt, transport, judge):
    run = load_run(run_dir)[0]
    return await mark_run(
        run=run,
        sheet=load_sheet(sheet_file),
        prompt=prompt,
        judge_model="deepseek:deepseek-v4-flash",
        pack_path=pack_file,
        transport=transport,
        judge=judge,
    )


async def test_a_marking_records_both_passes_and_what_produced_them(
    make_run, sheet_file, pack_file, prompt, transport
):
    marking = await _mark(
        make_run(),
        sheet_file,
        pack_file,
        prompt,
        transport(),
        fake_judge({"1.2": True, "1.4": True}),
    )
    assert marking["run_dir"] == "2026-08-24-a" and marking["task_number"] == 1
    assert marking["marking_sheet"]["sha256"] and marking["judge_prompt"]["sha256"]
    assert marking["judge_model"] == "deepseek:deepseek-v4-flash"
    assert marking["judge"]["usage"]["total_tokens"] == 4300
    assert marking["judge"]["cost_usd"] > 0
    assert marking["score"] == {"awarded": 4, "of": 4, "unresolved": 0}
    assert marking["marked_at"]
    # The transcript keeps the call itself, which is what a spot check reads.
    assert "nimbus daemon start" in marking["judge_input"]


async def test_the_judge_cannot_award_a_point_the_code_pass_refused(
    make_run, sheet_file, pack_file, prompt, transport
):
    run_dir = make_run(
        answer=f"Just run it in the cloud.\n\nSources\n{DOCS}/start\n",
        fetched=(f"{DOCS}/start",),
    )
    marking = await _mark(
        run_dir, sheet_file, pack_file, prompt, transport(), fake_judge({"1.2": True, "1.4": True})
    )
    points = {point["id"]: point for point in marking["points"]}
    assert points["1.4"]["code"]["verdict"] == "refused"
    assert points["1.4"]["judge"]["awarded"] is True
    assert points["1.4"]["awarded"] is False


async def test_a_judge_call_that_fails_leaves_its_points_unresolved(
    make_run, sheet_file, pack_file, prompt, transport
):
    async def broken(model, judge_input):
        raise RuntimeError("provider said no")

    marking = await _mark(make_run(), sheet_file, pack_file, prompt, transport(), broken)
    points = {point["id"]: point for point in marking["points"]}
    assert marking["judge"]["error"].endswith("provider said no")
    assert points["1.2"]["awarded"] is None and points["1.1"]["awarded"] is True
    assert marking["score"]["unresolved"] == 2


async def test_the_code_pass_alone_marks_without_a_judge(
    make_run, sheet_file, pack_file, transport
):
    run = load_run(make_run())[0]
    marking = await mark_run(
        run=run,
        sheet=load_sheet(sheet_file),
        prompt=None,
        judge_model="unused",
        pack_path=pack_file,
        transport=transport(),
        judge=None,
    )
    assert marking["judge"] is None and marking["judge_input"] == ""
    assert marking["score"]["awarded"] == 2 and marking["score"]["unresolved"] == 2


async def test_the_summary_table_holds_one_row_per_point(
    make_run, sheet_file, pack_file, prompt, transport
):
    marking = await _mark(
        make_run(),
        sheet_file,
        pack_file,
        prompt,
        transport(),
        fake_judge({"1.2": False, "1.4": True}),
    )
    table = summary_table([marking])
    assert table.count("| 2026-08-24-a |") == 4
    assert "because 1.2" in table and "refused" in table


async def test_the_live_page_a_sheet_pins_is_fetched_at_marking_time(
    make_run, sheet_file, pack_file, prompt, transport
):
    checker = transport()
    marking = await _mark(
        make_run(), sheet_file, pack_file, prompt, checker, fake_judge({"1.2": True, "1.4": True})
    )
    assert f"{DOCS}/start" in checker.urls
    assert marking["live_pages"][0]["status"] == 200
    # The page's text rides in the judge call, not twice in the transcript.
    assert "text" not in marking["live_pages"][0]


async def test_the_transcript_is_json_serialisable(
    make_run, sheet_file, pack_file, prompt, transport, tmp_path
):
    marking = await _mark(
        make_run(), sheet_file, pack_file, prompt, transport(), fake_judge({"1.2": True})
    )
    path = tmp_path / "marking.json"
    path.write_text(json.dumps(marking, indent=2), encoding="utf-8")
    assert json.loads(path.read_text(encoding="utf-8"))["schema"] == "benchmark-marking/1"


async def test_a_decorated_verdict_id_still_resolves_to_its_point(
    make_run, sheet_file, pack_file, prompt, transport
):
    """The 2026-08-26 calibration run: the judge returned "Point 1.2", the sheet says "1.2".

    The prompt renders each criterion as `### Point 1.2`, so the decoration is invited and
    recurs at random. It must not read as an unresolved point.
    """
    marking = await _mark(
        make_run(),
        sheet_file,
        pack_file,
        prompt,
        transport(),
        fake_judge({"Point 1.2": True, "point 01.4": False}),
    )
    points = {point["id"]: point for point in marking["points"]}
    assert points["1.2"]["judge"] == {
        "id": "Point 1.2",
        "awarded": True,
        "justification": "because Point 1.2",
    }
    assert points["1.4"]["judge"]["awarded"] is False
    assert marking["score"]["unresolved"] == 0
    assert marking["unmatched_verdicts"] == []


async def test_a_verdict_for_no_point_on_the_sheet_is_recorded_not_dropped(
    make_run, sheet_file, pack_file, prompt, transport
):
    marking = await _mark(
        make_run(),
        sheet_file,
        pack_file,
        prompt,
        transport(),
        fake_judge({"1.2": True, "1.4": True, "9.9": True}),
    )
    assert [verdict["id"] for verdict in marking["unmatched_verdicts"]] == ["9.9"]
    assert marking["score"]["awarded"] == 4


async def test_two_verdicts_for_one_point_keep_the_first_and_record_the_spare(
    make_run, sheet_file, pack_file, prompt, transport
):
    """Normalisation can collide: `"Point 1.2"` and `"1.2"` are one key.

    The first answer stands and the second is recorded, so a judge that marks a point twice
    cannot overwrite itself out of sight.
    """

    async def judge(model: str, judge_input: str) -> JudgeResult:
        return JudgeResult(
            verdicts=[
                JudgeVerdict(point_id="1.2", awarded=True, justification="first"),
                JudgeVerdict(point_id="Point 1.2", awarded=False, justification="second"),
                JudgeVerdict(point_id="1.4", awarded=True, justification="because 1.4"),
            ],
            usage={},
        )

    marking = await _mark(make_run(), sheet_file, pack_file, prompt, transport(), judge)
    points = {point["id"]: point for point in marking["points"]}
    assert points["1.2"]["judge"]["justification"] == "first"
    assert marking["unmatched_verdicts"] == [
        {"id": "Point 1.2", "awarded": False, "justification": "second"}
    ]


@pytest.mark.parametrize(
    "written,expected",
    [
        ("1.2", "1.2"),
        ("Point 1.2", "1.2"),
        ("point 1.2", "1.2"),
        ("  POINT  1.2 ", "1.2"),
        ("Point: 1.2", "1.2"),
        ("#1.2", "1.2"),
        ("Point 01.02", "1.2"),
        ("1.2.", "1.2"),
    ],
)
def test_the_join_key_survives_how_the_judge_writes_an_id(written, expected):
    assert normalise_point_id(written) == expected


def test_a_prompt_object_is_what_the_marker_records():
    prompt = JudgePrompt(path=__import__("pathlib").Path("p.md"), sha256="abc", template="")
    assert prompt.identity() == {"path": "p.md", "sha256": "abc"}
