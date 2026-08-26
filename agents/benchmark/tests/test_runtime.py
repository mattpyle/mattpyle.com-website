# ABOUTME: Tests for the per-run settings and the run-directory naming they feed.
#
# Like the fetch tests, these import only harness-free modules: `benchmark.runtime` reads the
# environment and builds a settings object, and nothing here starts a model, a worker or a server.

from __future__ import annotations

import pytest

from benchmark.routes import DEFAULT_MODEL_ACTIVITY_SECONDS, DEFAULT_TOKEN_BUDGET
from benchmark.runtime import DEFAULT_MODEL, current_settings, model_slug


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    """`current_settings` is cached for the life of a worker process; a test is not one."""
    current_settings.cache_clear()
    yield
    current_settings.cache_clear()


def test_default_model_is_deepseek():
    assert DEFAULT_MODEL == "deepseek:deepseek-v4-flash"


@pytest.mark.parametrize(
    ("model", "expected"),
    [
        ("deepseek:deepseek-v4-flash", "deepseek-v4-flash"),
        ("google:gemini-3.5-flash", "google-gemini-3-5-flash"),
        ("anthropic:claude-sonnet-5", "anthropic-claude-sonnet-5"),
        ("some/model:with spaces", "some-model-with-spaces"),
    ],
)
def test_model_slug_is_filesystem_safe(model, expected):
    assert model_slug(model) == expected


def test_settings_default_to_non_thinking_with_a_token_budget(monkeypatch):
    for name in (
        "BENCHMARK_THINKING",
        "BENCHMARK_TOKEN_BUDGET",
        "BENCHMARK_MODEL_ACTIVITY_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)
    settings = current_settings()
    assert settings.thinking is False
    assert settings.token_budget == DEFAULT_TOKEN_BUDGET
    assert settings.model_activity_seconds == DEFAULT_MODEL_ACTIVITY_SECONDS


def test_settings_read_the_run_environment(monkeypatch):
    monkeypatch.setenv("BENCHMARK_THINKING", "on")
    monkeypatch.setenv("BENCHMARK_TOKEN_BUDGET", "1234")
    monkeypatch.setenv("BENCHMARK_MODEL_ACTIVITY_SECONDS", "45")
    settings = current_settings()
    assert settings.thinking is True
    assert settings.token_budget == 1234
    assert settings.model_activity_seconds == 45.0


def test_a_zero_token_budget_disables_the_limit(monkeypatch):
    monkeypatch.setenv("BENCHMARK_TOKEN_BUDGET", "0")
    assert current_settings().token_budget is None
