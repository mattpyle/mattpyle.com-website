# ABOUTME: Tests for the CLI's pre-flight checks and for how a run ends its workflow.
#
# `main` returns 2 without reaching the network when the chosen model's key is missing, so those
# tests exercise the real entry point rather than a stand-in. The ending tests drive `_end_workflow`
# against a stand-in handle, because the thing under test is which of the two endings gets recorded.

from __future__ import annotations

import asyncio

import pytest

from benchmark.cli import _end_workflow, _temporal_address_problem, main

PROVIDER_KEYS = ("DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY")


@pytest.fixture
def no_provider_keys(monkeypatch, tmp_path):
    # `main` loads `.env.local` before it checks anything, so the test points that at a path with
    # no file: without this the machine's own keys decide the result.
    monkeypatch.setenv("BENCHMARK_ENV_FILE", str(tmp_path / "absent.env"))
    for name in (*PROVIDER_KEYS, "BENCHMARK_MODEL"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize(
    ("model", "expected_key"),
    [
        ("deepseek:deepseek-v4-flash", "DEEPSEEK_API_KEY"),
        ("google:gemini-3.5-flash", "GOOGLE_API_KEY"),
        ("anthropic:claude-sonnet-5", "ANTHROPIC_API_KEY"),
    ],
)
def test_missing_key_exits_two_and_names_the_right_key(
    model, expected_key, no_provider_keys, capsys
):
    assert main(["--task", "1", "--route", "c", "--model", model]) == 2
    assert expected_key in capsys.readouterr().err


def test_the_default_model_asks_for_the_deepseek_key(no_provider_keys, capsys):
    assert main(["--task", "1", "--route", "c"]) == 2
    assert "DEEPSEEK_API_KEY" in capsys.readouterr().err


def test_the_key_check_runs_before_any_run_directory_is_made(
    no_provider_keys, tmp_path, capsys
):
    assert main(["--task", "1", "--route", "c", "--out", str(tmp_path)]) == 2
    capsys.readouterr()
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    "address", ["localhost:7233", "127.0.0.1:7233", "[::1]:7233"]
)
def test_a_loopback_address_needs_no_temporal_key(address):
    assert _temporal_address_problem(address, "") is None


def test_a_remote_address_with_no_temporal_key_is_refused():
    problem = _temporal_address_problem("ns.acct.tmprl.cloud:7233", "")
    assert problem is not None and "TEMPORAL_API_KEY" in problem


def test_a_remote_address_with_a_temporal_key_is_allowed():
    assert _temporal_address_problem("ns.acct.tmprl.cloud:7233", "a-key") is None


class _FakeHandle:
    """A workflow handle that records what it was asked to do.

    `never_ends=True` makes `result()` wait forever, which is the wedged close the fallback exists
    for; `result_error` is a workflow that ended some other way.
    """

    def __init__(self, *, never_ends: bool = False, result_error: Exception | None = None):
        self.never_ends = never_ends
        self.result_error = result_error
        self.signals: list[str] = []
        self.terminate_reasons: list[str] = []

    async def signal(self, name: str) -> None:
        self.signals.append(name)

    async def result(self) -> None:
        if self.never_ends:
            await asyncio.Event().wait()
        if self.result_error is not None:
            raise self.result_error

    async def terminate(self, reason: str = "") -> None:
        self.terminate_reasons.append(reason)


def test_a_run_ends_by_signalling_close_and_records_completed():
    handle = _FakeHandle()
    assert asyncio.run(_end_workflow(handle)) == "completed"
    assert handle.signals == ["close"]
    assert handle.terminate_reasons == []


def test_a_close_that_never_lands_falls_back_to_terminate_and_says_so():
    handle = _FakeHandle(never_ends=True)
    ending = asyncio.run(_end_workflow(handle, timeout=0.05))
    assert ending == "terminated-after-close-timeout"
    assert handle.signals == ["close"]
    assert "close timed out" in handle.terminate_reasons[0]


def test_a_workflow_that_ends_badly_is_recorded_rather_than_raised():
    handle = _FakeHandle(result_error=RuntimeError("workflow failed"))
    assert asyncio.run(_end_workflow(handle)) == "failed: RuntimeError"
    assert handle.terminate_reasons == []
