# ABOUTME: The per-run settings the worker process reads from its environment, and the single
# FetchTool instance those settings build.
#
# One worker process serves exactly one run, so the run's counters (fetches used, wall-time clock)
# can live in the process. The CLI sets these variables before it starts the worker; nothing here
# is read from inside a workflow, so none of it touches determinism.

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .fetch import Budgets, FetchTool, httpx_transport
from .routes import DEFAULT_BUDGETS, Route, route_by_name

__all__ = ["RunSettings", "current_settings", "current_fetch_tool", "system_prompt"]

DEFAULT_MODEL = "anthropic:claude-sonnet-5"


@dataclass(frozen=True)
class RunSettings:
    route: Route
    budgets: Budgets
    fetch_log: Path
    model: str


def _int_env(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw else fallback


def _float_env(name: str, fallback: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw else fallback


@lru_cache(maxsize=1)
def current_settings() -> RunSettings:
    route = route_by_name(os.environ.get("BENCHMARK_ROUTE", "a"))
    budgets = Budgets(
        max_fetches=_int_env("BENCHMARK_MAX_FETCHES", DEFAULT_BUDGETS.max_fetches),
        max_bytes_per_response=_int_env(
            "BENCHMARK_MAX_BYTES", DEFAULT_BUDGETS.max_bytes_per_response
        ),
        wall_time_seconds=_float_env(
            "BENCHMARK_WALL_SECONDS", DEFAULT_BUDGETS.wall_time_seconds
        ),
    )
    fetch_log = Path(os.environ.get("BENCHMARK_FETCH_LOG", "fetches.jsonl"))
    return RunSettings(
        route=route,
        budgets=budgets,
        fetch_log=fetch_log,
        model=os.environ.get("BENCHMARK_MODEL", DEFAULT_MODEL),
    )


@lru_cache(maxsize=1)
def current_fetch_tool() -> FetchTool:
    settings = current_settings()
    return FetchTool(
        rules=settings.route.rules,
        budgets=settings.budgets,
        log_path=settings.fetch_log,
        transport=httpx_transport,
    )


def system_prompt(settings: RunSettings | None = None) -> str:
    """The agent's standing instructions.

    These state the rules the task pack puts on the agent — cite the URLs the answer relies on,
    work only from fetched pages — and the mechanics of the route it is on. They never describe
    what the marking sheet checks.
    """
    settings = settings or current_settings()
    budgets = settings.budgets
    return f"""\
You are answering one question for a person who asked their assistant for help. Answer it the way
a knowledgeable colleague would: directly, in prose, at the length the question deserves.

Everything you say must come from pages you fetch during this conversation. You have one tool,
`fetch_url`, and no web search. Do not answer from memory: if you have not read it on a page you
fetched, do not state it.

Start from {settings.route.entry_url} and follow links from there.

Only official Temporal sources are reachable: temporal.io, docs.temporal.io, learn.temporal.io,
and github.com/temporalio/*. Some URLs will be refused. A refusal tells you why; read it and take
another path rather than retrying the same URL.

This run allows at most {budgets.max_fetches} fetches and {budgets.wall_time_seconds:.0f} seconds
of wall time, and keeps at most {budgets.max_bytes_per_response} bytes of each response. Spend
them on the pages most likely to answer the question, and answer with what you have rather than
running out.

End your answer with a "Sources" list of the exact URLs your answer relies on, one per line. List
only URLs you actually fetched in this conversation.\
"""
