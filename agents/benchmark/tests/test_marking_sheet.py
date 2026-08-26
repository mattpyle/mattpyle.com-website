# ABOUTME: Tests for reading the machine-readable marking sheet.
#
# The sheet is the only place a marking criterion lives, so a malformed one has to fail loudly at
# load rather than quietly mark nothing.

from __future__ import annotations

import pytest

from benchmark.marking_sheet import default_sheet_path, load_sheet


def test_it_reads_the_points_and_their_split(sheet_file):
    sheet = load_sheet(sheet_file)
    assert sheet.version == "fixture-v1"
    assert sheet.sha256 and len(sheet.sha256) == 64
    task = sheet.task(1)
    assert [point.id for point in task.points] == ["1.1", "1.2", "1.3", "1.4"]
    assert task.point("1.1").code_checked and not task.point("1.1").judge_checked
    assert task.point("1.2").judge_checked and not task.point("1.2").code_checked
    assert task.point("1.4").code_checked and task.point("1.4").judge_checked
    assert task.point("1.4").required_strings == (("temporal server start-dev",),)
    assert task.live_pages == ("https://docs.temporal.io/develop/python/set-up-your-local-python",)


def test_the_identity_it_records_names_the_file(sheet_file):
    identity = load_sheet(sheet_file).identity()
    assert identity["path"] == str(sheet_file) and identity["sha256"]


def test_a_missing_sheet_says_where_it_looked(tmp_path):
    with pytest.raises(SystemExit) as caught:
        load_sheet(tmp_path / "absent.yaml")
    assert "BENCHMARK_MARKING_SHEET" in str(caught.value)


def test_the_env_override_points_somewhere_else(tmp_path, monkeypatch):
    monkeypatch.setenv("BENCHMARK_MARKING_SHEET", str(tmp_path / "other.yaml"))
    assert default_sheet_path() == tmp_path / "other.yaml"


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ('tasks:\n  - number: 1\n    points:\n      - id: "1.1"\n        checks: [sniff]\n', "checks"),
        ('tasks:\n  - number: 1\n    points:\n      - id: "1.1"\n        checks: [code]\n', "code-checked"),
        (
            'tasks:\n  - number: 1\n    points:\n      - id: "1.1"\n        checks: [judge]\n        colour: red\n',
            "unknown keys",
        ),
        ('tasks: []\n', "no tasks"),
    ],
)
def test_a_sheet_it_cannot_mark_from_is_refused(tmp_path, body, expected):
    path = tmp_path / "bad.yaml"
    path.write_text(body, encoding="utf-8")
    with pytest.raises(SystemExit) as caught:
        load_sheet(path)
    assert expected in str(caught.value)
