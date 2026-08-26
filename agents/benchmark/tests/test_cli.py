# ABOUTME: Tests for the CLI's provider key check — the one thing `benchmark-run` decides before
# it imports the harness, connects to anything, or spends a token.
#
# `main` returns 2 without reaching the network when the chosen model's key is missing, so these
# tests exercise the real entry point rather than a stand-in.

from __future__ import annotations

import pytest

from benchmark.cli import _temporal_address_problem, main

PROVIDER_KEYS = ("DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY")


@pytest.fixture
def no_provider_keys(monkeypatch):
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
