# ABOUTME: The three arms of the benchmark, as configuration. Each names the surfaces its agent
# can reach and the URL it starts from. The entry URL lives here rather than in the task prompt:
# the prompt is identical across routes, and the route is the only thing that varies.
#
# Like fetch.py, this module imports nothing from the agent harness.

from __future__ import annotations

from dataclasses import dataclass

from .fetch import Budgets, RouteRules

__all__ = ["Route", "ROUTES", "route_by_name", "DEFAULT_BUDGETS"]


@dataclass(frozen=True)
class Route:
    """One arm: the rules the fetch tool enforces, plus where the agent starts."""

    name: str
    label: str
    entry_url: str
    rules: RouteRules


ROUTES: dict[str, Route] = {
    "a": Route(
        name="a",
        label="HTML only",
        entry_url="https://temporal.io/",
        rules=RouteRules(
            name="a",
            allow_llms_txt=False,
            allow_markdown=False,
            accept_header="text/html",
        ),
    ),
    "b": Route(
        name="b",
        label="llms.txt entry, HTML pages",
        entry_url="https://temporal.io/llms.txt",
        rules=RouteRules(
            name="b",
            allow_llms_txt=True,
            allow_markdown=False,
            accept_header="text/html",
        ),
    ),
    "c": Route(
        name="c",
        label="llms.txt entry, markdown pages",
        entry_url="https://temporal.io/llms.txt",
        rules=RouteRules(
            name="c",
            allow_llms_txt=True,
            allow_markdown=True,
            accept_header="text/html",
        ),
    ),
}

# Identical across routes within a run, which is what makes the comparison a comparison.
DEFAULT_BUDGETS = Budgets(
    max_fetches=25,
    max_bytes_per_response=60_000,
    wall_time_seconds=600.0,
)


def route_by_name(name: str) -> Route:
    try:
        return ROUTES[name.lower()]
    except KeyError:
        raise SystemExit(
            f"unknown route {name!r}; expected one of {', '.join(sorted(ROUTES))}"
        ) from None
