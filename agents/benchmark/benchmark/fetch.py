# ABOUTME: The condition-enforcing fetch tool. One function the agent can call, wrapped in the
# rules that make an entry route mean something: a domain allowlist, per-route rules about which
# surfaces are reachable, run budgets, and a JSONL log of every request.
#
# This module deliberately imports NOTHING from the agent harness. It is the part of the rig that
# has to survive a change of rig: if temporal-agent-harness is replaced by a plain agent loop, this
# file moves across unchanged and only its adapter is rewritten.

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable, Protocol
from urllib.parse import urlsplit

__all__ = [
    "Budgets",
    "FetchResult",
    "FetchTool",
    "RouteRules",
    "Transport",
    "classify_url",
    "host_is_allowed",
]


# ---------------------------------------------------------------------------
# The allowlist
# ---------------------------------------------------------------------------

# Hosts reachable in full. `www.temporal.io` is included as an alias of the apex: the site does not
# redirect between them today, but a single redirect either way would otherwise strand every run.
ALLOWED_HOSTS: frozenset[str] = frozenset(
    {
        "temporal.io",
        "www.temporal.io",
        "docs.temporal.io",
        "learn.temporal.io",
    }
)

# Hosts reachable only under a path prefix.
ALLOWED_HOST_PREFIXES: dict[str, tuple[str, ...]] = {
    "github.com": ("/temporalio/",),
}

REFUSAL_OFF_ALLOWLIST = "off-allowlist"
REFUSAL_SCHEME = "bad-scheme"
REFUSAL_ROUTE_MARKDOWN = "route-refuses-markdown"
REFUSAL_ROUTE_LLMS_TXT = "route-refuses-llms-txt"
REFUSAL_BUDGET_FETCHES = "budget-fetches-exhausted"
REFUSAL_BUDGET_WALL_TIME = "budget-wall-time-exhausted"
REFUSAL_TRANSPORT_ERROR = "transport-error"


def host_is_allowed(url: str) -> bool:
    """Whether `url` is on the benchmark's domain allowlist."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host in ALLOWED_HOSTS:
        return True
    prefixes = ALLOWED_HOST_PREFIXES.get(host)
    if prefixes is None:
        return False
    path = parts.path or "/"
    return any(path.startswith(prefix) for prefix in prefixes)


def classify_url(url: str) -> str:
    """Name the surface a URL points at: `llms_txt`, `markdown`, or `html`.

    Classification is by path alone, before any request is made, so a route refusal costs no
    traffic to the target site and reads the same way in the log every time.
    """
    path = (urlsplit(url).path or "/").lower()
    name = path.rsplit("/", 1)[-1]
    if name in {"llms.txt", "llms-full.txt"}:
        return "llms_txt"
    if name.endswith(".md"):
        return "markdown"
    return "html"


# ---------------------------------------------------------------------------
# Run configuration
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RouteRules:
    """Which surfaces one arm of the benchmark can reach, and how it asks for them."""

    name: str
    allow_llms_txt: bool
    allow_markdown: bool
    accept_header: str = "text/html"


@dataclass(frozen=True)
class Budgets:
    """The limits held identical across routes within a benchmark run.

    `max_fetches` counts requests that actually went to the network. A refusal never reaches the
    network, so it does not spend the budget — it costs the agent a turn, which is the cost that
    should differ between routes.
    """

    max_fetches: int = 25
    max_bytes_per_response: int = 60_000
    wall_time_seconds: float = 600.0


@dataclass(frozen=True)
class FetchResult:
    """What one call to the tool did, in the form the log and the model both read from."""

    url: str
    served: bool
    status: int | None = None
    content_type: str | None = None
    body: str = ""
    refusal_reason: str | None = None
    detail: str = ""
    bytes_kept: int = 0
    bytes_received: int | None = None
    truncated: bool = False
    elapsed_ms: int = 0


class Transport(Protocol):
    """The network. Injected so the tests run with no network and no model."""

    async def __call__(
        self, url: str, headers: dict[str, str]
    ) -> tuple[int, str | None, str]: ...


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------


@dataclass
class FetchTool:
    """One run's fetch tool: the rules, the budgets, the log, and the counters behind them.

    One instance is one run. It is constructed by the process that hosts the tool call, and its
    counters are that run's counters — a second run means a second instance (in practice, a second
    process), never a reset.
    """

    rules: RouteRules
    budgets: Budgets
    log_path: Path
    transport: Transport
    clock: Callable[[], float] = time.monotonic
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)

    fetches_used: int = field(default=0, init=False)
    _started_at: float | None = field(default=None, init=False)

    def deadline_remaining(self) -> float:
        """Seconds of wall-time budget left. The clock starts on the first call, not at
        construction, so worker startup is not charged to the agent."""
        if self._started_at is None:
            return self.budgets.wall_time_seconds
        return self.budgets.wall_time_seconds - (self.clock() - self._started_at)

    async def fetch(self, url: str) -> FetchResult:
        """Fetch one URL under this run's rules, log the attempt, and return the result."""
        if self._started_at is None:
            self._started_at = self.clock()
        started = self.clock()

        refusal = self._refuse(url)
        if refusal is not None:
            reason, detail = refusal
            result = FetchResult(
                url=url,
                served=False,
                refusal_reason=reason,
                detail=detail,
                elapsed_ms=int((self.clock() - started) * 1000),
            )
            self._log(result)
            return result

        self.fetches_used += 1
        try:
            status, content_type, body = await self.transport(
                url, {"Accept": self.rules.accept_header}
            )
        except Exception as exc:  # noqa: BLE001 - any transport failure is a logged fetch failure
            result = FetchResult(
                url=url,
                served=False,
                refusal_reason=REFUSAL_TRANSPORT_ERROR,
                detail=f"{type(exc).__name__}: {exc}",
                elapsed_ms=int((self.clock() - started) * 1000),
            )
            self._log(result)
            return result

        received = len(body.encode("utf-8", "replace"))
        kept, truncated = self._truncate(body)
        result = FetchResult(
            url=url,
            served=True,
            status=status,
            content_type=content_type,
            body=kept,
            bytes_kept=len(kept.encode("utf-8", "replace")),
            bytes_received=received,
            truncated=truncated,
            elapsed_ms=int((self.clock() - started) * 1000),
        )
        self._log(result)
        return result

    # -- rules ------------------------------------------------------------

    def _refuse(self, url: str) -> tuple[str, str] | None:
        """The refusal, if any, as `(reason, detail)`. Order matters: budgets are checked first so
        an exhausted run says so plainly rather than blaming the URL."""
        if self.deadline_remaining() <= 0:
            return (
                REFUSAL_BUDGET_WALL_TIME,
                f"This run's wall-time budget of {self.budgets.wall_time_seconds:.0f}s is spent. "
                "No further pages can be fetched. Answer from what you have already read.",
            )
        if self.fetches_used >= self.budgets.max_fetches:
            return (
                REFUSAL_BUDGET_FETCHES,
                f"This run's fetch budget of {self.budgets.max_fetches} requests is spent. "
                "No further pages can be fetched. Answer from what you have already read.",
            )

        scheme = urlsplit(url).scheme.lower()
        if scheme not in {"http", "https"}:
            return (
                REFUSAL_SCHEME,
                f"Only http and https URLs can be fetched; got {scheme or 'no scheme'!r}.",
            )

        if not host_is_allowed(url):
            return (
                REFUSAL_OFF_ALLOWLIST,
                "That URL is not on this run's allowlist. Reachable sources are temporal.io, "
                "docs.temporal.io, learn.temporal.io, and github.com/temporalio/*. There is no "
                "web search available.",
            )

        kind = classify_url(url)
        if kind == "markdown" and not self.rules.allow_markdown:
            return (
                REFUSAL_ROUTE_MARKDOWN,
                "Markdown pages are not available on this run. Read the site's HTML pages instead.",
            )
        if kind == "llms_txt" and not self.rules.allow_llms_txt:
            return (
                REFUSAL_ROUTE_LLMS_TXT,
                "llms.txt files are not available on this run. Read the site's HTML pages instead.",
            )
        return None

    def _truncate(self, body: str) -> tuple[str, bool]:
        limit = self.budgets.max_bytes_per_response
        raw = body.encode("utf-8", "replace")
        if len(raw) <= limit:
            return body, False
        kept = raw[:limit].decode("utf-8", "ignore")
        note = (
            f"\n\n[truncated: the response was {len(raw)} bytes and this run keeps at most "
            f"{limit}; the text above is the first {limit} bytes]"
        )
        return kept + note, True

    # -- logging ----------------------------------------------------------

    def _log(self, result: FetchResult) -> None:
        """Append one line to the run's fetch log. The log is the record marking reads from, so it
        is written for every attempt, served or refused, before the result reaches the model."""
        record = {
            "timestamp": self.now().isoformat(),
            "route": self.rules.name,
            "url": result.url,
            "kind": classify_url(result.url),
            "served": result.served,
            "status": result.status,
            "content_type": result.content_type,
            "bytes_kept": result.bytes_kept,
            "bytes_received": result.bytes_received,
            "truncated": result.truncated,
            "refusal_reason": result.refusal_reason,
            "detail": result.detail if not result.served else "",
            "elapsed_ms": result.elapsed_ms,
            "fetches_used": self.fetches_used,
        }
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def render_for_model(result: FetchResult) -> str:
    """The tool's return string: what the model sees for one call.

    A refusal says why in plain words, because the agent is meant to adapt to the route rather
    than retry blindly against them.
    """
    if not result.served:
        return f"REFUSED {result.url}\nReason: {result.refusal_reason}\n{result.detail}"
    header = (
        f"FETCHED {result.url}\n"
        f"Status: {result.status}\n"
        f"Content-Type: {result.content_type or 'unknown'}\n"
    )
    return header + "\n" + result.body


async def httpx_transport(url: str, headers: dict[str, str]) -> tuple[int, str | None, str]:
    """The real network, kept out of the tool so the tests never reach it."""
    import httpx

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=30.0,
        headers={"User-Agent": USER_AGENT},
    ) as client:
        response = await client.get(url, headers=headers)
        return response.status_code, response.headers.get("content-type"), response.text


# The rig identifies itself, so a run is one recognisable visitor in temporal.io's logs.
USER_AGENT = "mattpyle-benchmark/0.1 (+https://www.mattpyle.com/)"
