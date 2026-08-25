# ABOUTME: Tests for the condition-enforcing fetch tool. They import only `benchmark.fetch` and
# `benchmark.routes`, so they run with no harness, no model, and no network — which is the point
# of keeping the fetch tool free of harness imports.

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from benchmark.fetch import (
    REFUSAL_BUDGET_FETCHES,
    REFUSAL_BUDGET_WALL_TIME,
    REFUSAL_OFF_ALLOWLIST,
    REFUSAL_ROUTE_LLMS_TXT,
    REFUSAL_ROUTE_MARKDOWN,
    REFUSAL_SCHEME,
    REFUSAL_TRANSPORT_ERROR,
    Budgets,
    FetchTool,
    classify_url,
    host_is_allowed,
)
from benchmark.routes import ROUTES


class FakeTransport:
    """Records what was asked for and returns a canned page. Never touches the network."""

    def __init__(self, body: str = "hello", status: int = 200, content_type: str = "text/html"):
        self.body = body
        self.status = status
        self.content_type = content_type
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def __call__(self, url: str, headers: dict[str, str]):
        self.calls.append((url, dict(headers)))
        return self.status, self.content_type, self.body


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


def build(route: str, tmp_path: Path, *, transport=None, budgets=None, clock=None) -> FetchTool:
    return FetchTool(
        rules=ROUTES[route].rules,
        budgets=budgets or Budgets(max_fetches=5, max_bytes_per_response=1000, wall_time_seconds=60),
        log_path=tmp_path / "fetches.jsonl",
        transport=transport or FakeTransport(),
        clock=clock or FakeClock(),
        now=lambda: datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc),
    )


def read_log(tmp_path: Path) -> list[dict]:
    text = (tmp_path / "fetches.jsonl").read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# URL classification and the domain allowlist
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://temporal.io/llms.txt", "llms_txt"),
        ("https://temporal.io/llms-full.txt", "llms_txt"),
        ("https://temporal.io/pricing.md", "markdown"),
        ("https://docs.temporal.io/develop/python/index.md", "markdown"),
        ("https://temporal.io/pricing", "html"),
        ("https://docs.temporal.io/", "html"),
        ("https://temporal.io/PRICING.MD", "markdown"),
    ],
)
def test_classify_url(url, expected):
    assert classify_url(url) == expected


@pytest.mark.parametrize(
    "url,allowed",
    [
        ("https://temporal.io/pricing", True),
        ("https://www.temporal.io/pricing", True),
        ("https://docs.temporal.io/develop/python", True),
        ("https://learn.temporal.io/getting_started/python/", True),
        ("https://github.com/temporalio/sdk-python", True),
        ("https://github.com/someoneelse/repo", False),
        ("https://github.com/", False),
        ("https://raw.githubusercontent.com/temporalio/x/main/README.md", False),
        ("https://temporal.io.evil.example/", False),
        ("https://google.com/search?q=temporal", False),
    ],
)
def test_host_is_allowed(url, allowed):
    assert host_is_allowed(url) is allowed


async def test_off_allowlist_is_refused_and_never_reaches_the_transport(tmp_path):
    transport = FakeTransport()
    tool = build("c", tmp_path, transport=transport)

    result = await tool.fetch("https://google.com/search?q=temporal")

    assert result.served is False
    assert result.refusal_reason == REFUSAL_OFF_ALLOWLIST
    assert transport.calls == []
    assert tool.fetches_used == 0


async def test_non_http_scheme_is_refused(tmp_path):
    tool = build("c", tmp_path)
    result = await tool.fetch("file:///etc/passwd")
    assert result.refusal_reason == REFUSAL_SCHEME


# ---------------------------------------------------------------------------
# Route rules
# ---------------------------------------------------------------------------


async def test_route_a_refuses_llms_txt_and_markdown(tmp_path):
    transport = FakeTransport()
    tool = build("a", tmp_path, transport=transport)

    llms = await tool.fetch("https://temporal.io/llms.txt")
    full = await tool.fetch("https://temporal.io/llms-full.txt")
    markdown = await tool.fetch("https://temporal.io/pricing.md")
    html = await tool.fetch("https://temporal.io/pricing")

    assert llms.refusal_reason == REFUSAL_ROUTE_LLMS_TXT
    assert full.refusal_reason == REFUSAL_ROUTE_LLMS_TXT
    assert markdown.refusal_reason == REFUSAL_ROUTE_MARKDOWN
    assert html.served is True
    assert [url for url, _ in transport.calls] == ["https://temporal.io/pricing"]


async def test_route_a_asks_for_html(tmp_path):
    transport = FakeTransport()
    tool = build("a", tmp_path, transport=transport)
    await tool.fetch("https://temporal.io/pricing")
    assert transport.calls[0][1]["Accept"] == "text/html"


async def test_route_b_serves_llms_txt_and_refuses_markdown(tmp_path):
    tool = build("b", tmp_path)

    llms = await tool.fetch("https://temporal.io/llms.txt")
    markdown = await tool.fetch("https://temporal.io/pricing.md")
    html = await tool.fetch("https://docs.temporal.io/develop/python")

    assert llms.served is True
    assert markdown.refusal_reason == REFUSAL_ROUTE_MARKDOWN
    assert html.served is True


async def test_route_c_serves_everything_on_the_allowlist(tmp_path):
    tool = build("c", tmp_path)

    for url in (
        "https://temporal.io/llms.txt",
        "https://temporal.io/pricing.md",
        "https://docs.temporal.io/develop/python",
    ):
        assert (await tool.fetch(url)).served is True


# ---------------------------------------------------------------------------
# Budgets
# ---------------------------------------------------------------------------


async def test_fetch_budget_exhausts_and_refusals_do_not_spend_it(tmp_path):
    transport = FakeTransport()
    tool = build(
        "c",
        tmp_path,
        transport=transport,
        budgets=Budgets(max_fetches=2, max_bytes_per_response=1000, wall_time_seconds=60),
    )

    # A refusal costs no budget: it never reaches the network.
    await tool.fetch("https://google.com/")
    assert tool.fetches_used == 0

    assert (await tool.fetch("https://temporal.io/a")).served is True
    assert (await tool.fetch("https://temporal.io/b")).served is True

    exhausted = await tool.fetch("https://temporal.io/c")
    assert exhausted.served is False
    assert exhausted.refusal_reason == REFUSAL_BUDGET_FETCHES
    assert len(transport.calls) == 2


async def test_wall_time_budget_exhausts(tmp_path):
    clock = FakeClock()
    tool = build(
        "c",
        tmp_path,
        clock=clock,
        budgets=Budgets(max_fetches=99, max_bytes_per_response=1000, wall_time_seconds=30),
    )

    assert (await tool.fetch("https://temporal.io/a")).served is True
    clock.value = 31.0
    late = await tool.fetch("https://temporal.io/b")

    assert late.served is False
    assert late.refusal_reason == REFUSAL_BUDGET_WALL_TIME


async def test_wall_clock_starts_at_the_first_fetch_not_construction(tmp_path):
    clock = FakeClock()
    tool = build(
        "c",
        tmp_path,
        clock=clock,
        budgets=Budgets(max_fetches=9, max_bytes_per_response=1000, wall_time_seconds=30),
    )
    clock.value = 500.0  # worker startup, not the agent's doing
    assert (await tool.fetch("https://temporal.io/a")).served is True


async def test_response_is_truncated_and_says_so(tmp_path):
    transport = FakeTransport(body="x" * 5000)
    tool = build(
        "c",
        tmp_path,
        transport=transport,
        budgets=Budgets(max_fetches=9, max_bytes_per_response=100, wall_time_seconds=60),
    )

    result = await tool.fetch("https://temporal.io/big")

    assert result.truncated is True
    assert result.bytes_received == 5000
    assert result.body.startswith("x" * 100)
    assert "truncated" in result.body


async def test_short_response_is_not_truncated(tmp_path):
    tool = build("c", tmp_path, transport=FakeTransport(body="short"))
    result = await tool.fetch("https://temporal.io/small")
    assert result.truncated is False
    assert result.body == "short"


# ---------------------------------------------------------------------------
# Transport failure
# ---------------------------------------------------------------------------


async def test_transport_failure_is_logged_as_a_failed_fetch(tmp_path):
    async def boom(url, headers):
        raise TimeoutError("read timed out")

    tool = build("c", tmp_path, transport=boom)
    result = await tool.fetch("https://temporal.io/slow")

    assert result.served is False
    assert result.refusal_reason == REFUSAL_TRANSPORT_ERROR
    # It DID spend the fetch budget: the request went out.
    assert tool.fetches_used == 1
    assert read_log(tmp_path)[0]["refusal_reason"] == REFUSAL_TRANSPORT_ERROR


# ---------------------------------------------------------------------------
# The log
# ---------------------------------------------------------------------------


async def test_every_attempt_is_logged_with_the_marking_fields(tmp_path):
    tool = build("b", tmp_path)

    await tool.fetch("https://temporal.io/llms.txt")
    await tool.fetch("https://temporal.io/pricing.md")
    await tool.fetch("https://google.com/")

    records = read_log(tmp_path)
    assert len(records) == 3

    expected_fields = {
        "timestamp",
        "route",
        "url",
        "kind",
        "served",
        "status",
        "content_type",
        "bytes_kept",
        "bytes_received",
        "truncated",
        "refusal_reason",
        "detail",
        "elapsed_ms",
        "fetches_used",
    }
    for record in records:
        assert set(record) == expected_fields
        assert record["route"] == "b"

    served, refused_md, refused_domain = records
    assert served["served"] is True
    assert served["kind"] == "llms_txt"
    assert served["status"] == 200
    assert served["refusal_reason"] is None

    assert refused_md["served"] is False
    assert refused_md["kind"] == "markdown"
    assert refused_md["refusal_reason"] == REFUSAL_ROUTE_MARKDOWN
    assert refused_md["detail"]

    assert refused_domain["refusal_reason"] == REFUSAL_OFF_ALLOWLIST


async def test_log_is_appended_not_rewritten(tmp_path):
    tool = build("c", tmp_path)
    await tool.fetch("https://temporal.io/a")
    await tool.fetch("https://temporal.io/b")
    assert [r["url"] for r in read_log(tmp_path)] == [
        "https://temporal.io/a",
        "https://temporal.io/b",
    ]


# ---------------------------------------------------------------------------
# Route configuration
# ---------------------------------------------------------------------------


def test_each_route_has_the_entry_url_the_design_calls_for():
    assert ROUTES["a"].entry_url == "https://temporal.io/"
    assert ROUTES["b"].entry_url == "https://temporal.io/llms.txt"
    assert ROUTES["c"].entry_url == "https://temporal.io/llms.txt"
