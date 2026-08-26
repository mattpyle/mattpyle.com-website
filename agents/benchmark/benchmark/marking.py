# ABOUTME: The code pass. Everything a marking sheet can settle without a model call.
#
# Deterministic and offline-testable: the network arrives as an injected transport, so the tests
# run with no network, no model and no run of their own. The code pass is never overridden by the
# judge, per the scoring protocol's split, so what it decides here is final.

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from ipaddress import ip_address
from pathlib import Path
from typing import Iterable
from urllib.parse import urlsplit

from .fetch import USER_AGENT, Transport
from .marking_sheet import Point, TaskSheet

__all__ = [
    "Citation",
    "marking_transport",
    "PointResult",
    "CodePass",
    "RunArtifacts",
    "load_run",
    "parse_sources",
    "run_code_pass",
    "fetch_live_pages",
]

AWARDED = "awarded"
REFUSED = "refused"
NOT_CODE_CHECKED = "not-code-checked"

# How much of a page fetched at marking time is put in front of the judge. Enough to compare a
# command or a price against; not so much that five pages crowd out the answer.
LIVE_PAGE_CHARS = 6_000

# The marker fetches what an answer cites, and an answer is model output. These are the bounds on
# what that can cost: how many URLs one answer can send it to, and how much of any one response it
# will read before it stops. Both are far above what a real answer needs.
MAX_CITATIONS_CHECKED = 20
MAX_RESPONSE_BYTES = 400_000

# A Sources line is written every way a model writes one: bare, as a heading, bolded, with or
# without a colon. Nothing but the word and its decoration may be on the line.
_SOURCES_HEADING = re.compile(r"^\s{0,3}(?:#{1,6}\s*)?[*_\s]*sources[*_\s:]*$", re.IGNORECASE)
_URL = re.compile(r"https?://[^\s<>()\[\]\"'`]+")
_TRAILING_PUNCTUATION = ".,;:!?"


@dataclass(frozen=True)
class RunArtifacts:
    """One task's artifacts inside one run directory."""

    run_dir: Path
    task_number: int
    answer: str
    fetch_log: list[dict]
    summary: dict

    @property
    def name(self) -> str:
        return self.run_dir.name


@dataclass
class Citation:
    """One URL the answer says it relies on, and what the code pass found about it."""

    url: str
    served_in_run: bool = False
    attempted_in_run: bool = False
    run_status: int | None = None
    run_refusal_reason: str | None = None
    live_status: int | None = None
    live_error: str | None = None
    # Why the marker did not fetch this URL at all, if it did not.
    skipped_reason: str | None = None

    @property
    def resolves(self) -> bool:
        return self.live_status is not None and self.live_status < 400

    @property
    def sound(self) -> bool:
        """Pack rule 3: a citation counts only if it resolves and the run actually fetched it."""
        return self.served_in_run and self.resolves

    def as_dict(self) -> dict:
        return {
            "url": self.url,
            "served_in_run": self.served_in_run,
            "attempted_in_run": self.attempted_in_run,
            "run_status": self.run_status,
            "run_refusal_reason": self.run_refusal_reason,
            "live_status": self.live_status,
            "live_error": self.live_error,
            "skipped_reason": self.skipped_reason,
            "resolves": self.resolves,
            "sound": self.sound,
        }


@dataclass
class PointResult:
    point_id: str
    checks: tuple[str, ...]
    verdict: str
    reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "id": self.point_id,
            "checks": list(self.checks),
            "verdict": self.verdict,
            "reasons": list(self.reasons),
        }


@dataclass
class CodePass:
    citations: list[Citation]
    points: list[PointResult]
    sources_section_found: bool

    def as_dict(self) -> dict:
        return {
            "sources_section_found": self.sources_section_found,
            "citations": [citation.as_dict() for citation in self.citations],
            "points": [point.as_dict() for point in self.points],
        }


# ---------------------------------------------------------------------------
# Reading a run directory
# ---------------------------------------------------------------------------


def load_run(run_dir: Path, task_number: int | None = None) -> list[RunArtifacts]:
    """Read every task in one run directory. A run holds one task today; the shape allows more."""
    if not run_dir.is_dir():
        raise SystemExit(f"run directory not found: {run_dir}")

    summaries = sorted(run_dir.glob("task-*-run.json"))
    if not summaries:
        raise SystemExit(f"{run_dir} holds no task-*-run.json; it is not a benchmark run directory")

    runs: list[RunArtifacts] = []
    for summary_path in summaries:
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        number = int(summary.get("task_number") or _task_number_from(summary_path))
        if task_number is not None and number != task_number:
            continue
        prefix = f"task-{number}"
        answer_path = run_dir / f"{prefix}-answer.md"
        fetch_path = run_dir / f"{prefix}-fetches.jsonl"
        runs.append(
            RunArtifacts(
                run_dir=run_dir,
                task_number=number,
                answer=answer_path.read_text(encoding="utf-8") if answer_path.is_file() else "",
                fetch_log=_read_jsonl(fetch_path),
                summary=summary,
            )
        )

    if not runs:
        raise SystemExit(f"{run_dir} holds no artifacts for task {task_number}")
    return runs


def _task_number_from(path: Path) -> int:
    match = re.search(r"task-(\d+)-run\.json$", path.name)
    if not match:
        raise SystemExit(f"cannot read a task number from {path.name}")
    return int(match.group(1))


def _read_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [
        json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]


# ---------------------------------------------------------------------------
# Citations
# ---------------------------------------------------------------------------


def parse_sources(answer: str) -> tuple[list[str], bool]:
    """Return the URLs of the answer's Sources list, and whether it had one.

    The answers vary: a bare `Sources` line, `## Sources`, bullets or plain lines, bare URLs or
    markdown links. Everything after the last Sources heading is read for URLs, in order, with
    duplicates dropped. With no heading the answer cites nothing, which is a finding rather than
    an error, and the whole answer is not scanned instead: a URL quoted mid-prose is not a
    citation the answer stands behind.
    """
    lines = answer.splitlines()
    start = None
    for index, line in enumerate(lines):
        if _SOURCES_HEADING.match(line):
            start = index + 1
    if start is None:
        return [], False

    seen: dict[str, None] = {}
    for line in lines[start:]:
        for match in _URL.finditer(line):
            seen.setdefault(match.group(0).rstrip(_TRAILING_PUNCTUATION), None)
    return list(seen), True


def normalise_url(url: str) -> str:
    """Compare URLs the way a reader would: scheme and case and a trailing slash do not matter."""
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = (parts.path or "/").rstrip("/") or "/"
    query = f"?{parts.query}" if parts.query else ""
    return f"{host}{path}{query}"


def _on_allowlist(url: str, allowed: Iterable[str]) -> bool:
    """Whether a cited URL is one of the pages a point allows.

    Anchored at the start of the normalised URL, so the entry stands for a host and a path prefix.
    An unanchored match would let `attacker.example/docs.temporal.io/quickstarts` satisfy
    `docs.temporal.io/quickstarts`, and the URLs here come out of untrusted answer text.
    """
    normalised = _page_key(url)
    for entry in allowed:
        prefix = _page_key(entry if "//" in entry else f"https://{entry}")
        if normalised == prefix or normalised.startswith(prefix.rstrip("/") + "/"):
            return True
    return False


def _page_key(url: str) -> str:
    """A URL as the page it names, with the markdown twin folded onto the HTML one.

    Route C is served `set-up-your-local-python.md` where route A reads
    `set-up-your-local-python`; the pack's allowed lists name one page, and both routes cite it.
    Only allowlist matching folds them: the fetch log is matched on the URL as fetched, because
    there a `.md` and its HTML twin are two different requests.
    """
    key = normalise_url(url)
    return key[:-3] if key.endswith(".md") else key


def _fetch_log_index(fetch_log: Iterable[dict]) -> dict[str, dict]:
    """The best record per URL: a served fetch beats a refusal, whatever the order."""
    index: dict[str, dict] = {}
    for record in fetch_log:
        key = normalise_url(str(record.get("url", "")))
        current = index.get(key)
        if current is None or (record.get("served") and not current.get("served")):
            index[key] = record
    return index


async def resolve_citations(
    urls: Iterable[str], fetch_log: Iterable[dict], transport: Transport
) -> list[Citation]:
    """Check every cited URL against the run's fetch log, then against the live web.

    The live fetch is pack rule 5's other half: a cited URL is checked as it reads at marking
    time, so a 404 that appeared after the run is recorded as a 404 now and not guessed at.
    """
    index = _fetch_log_index(fetch_log)
    citations: list[Citation] = []
    for position, url in enumerate(urls):
        record = index.get(normalise_url(url))
        citation = Citation(url=url)
        if record is not None:
            citation.attempted_in_run = True
            citation.served_in_run = bool(record.get("served"))
            citation.run_status = record.get("status")
            citation.run_refusal_reason = record.get("refusal_reason")

        citation.skipped_reason = _skip_reason(url, position)
        if citation.skipped_reason is None:
            try:
                status, _content_type, _body = await transport(url, {"Accept": "text/html"})
                citation.live_status = status
            except Exception as exc:  # noqa: BLE001 - any failure is a recorded citation failure
                citation.live_error = f"{type(exc).__name__}: {exc}"
        citations.append(citation)
    return citations


def _skip_reason(url: str, position: int) -> str | None:
    """Why this cited URL is not fetched at marking time, if it is not.

    The Sources list is model output, so the marker treats it as a list of requests a stranger
    asked it to make: a bounded number of them, https only, and never at an address that is not
    on the public internet. A skipped URL is recorded with its reason and marked as unresolved,
    which is the same outcome as a citation that does not resolve.
    """
    if position >= MAX_CITATIONS_CHECKED:
        return f"over the {MAX_CITATIONS_CHECKED}-citation cap for one answer"
    parts = urlsplit(url)
    if parts.scheme.lower() != "https":
        return f"not https ({parts.scheme or 'no scheme'})"
    host = (parts.hostname or "").strip("[]")
    try:
        address = ip_address(host)
    except ValueError:
        return None
    if not address.is_global:
        return f"not a public address ({host})"
    return None


async def marking_transport(url: str, headers: dict[str, str]) -> tuple[int, str | None, str]:
    """The network, as the marker uses it: streamed, and stopped at `MAX_RESPONSE_BYTES`.

    The run's own transport buffers the whole body, which is safe there because the fetch tool
    only reaches an allowlist. Here the URL came out of an answer, so the response is read in
    chunks and the read stops at the cap rather than the cap being applied to what already
    arrived.
    """
    import httpx

    async with httpx.AsyncClient(
        follow_redirects=True, timeout=30.0, headers={"User-Agent": USER_AGENT}
    ) as client:
        async with client.stream("GET", url, headers=headers) as response:
            chunks: list[bytes] = []
            kept = 0
            async for chunk in response.aiter_bytes():
                chunks.append(chunk)
                kept += len(chunk)
                if kept >= MAX_RESPONSE_BYTES:
                    break
            body = b"".join(chunks)[:MAX_RESPONSE_BYTES]
            return (
                response.status_code,
                response.headers.get("content-type"),
                body.decode(response.encoding or "utf-8", "replace"),
            )


async def fetch_live_pages(urls: Iterable[str], transport: Transport) -> list[dict]:
    """Fetch the pages a sheet pins for comparison at marking time (pack rule 5)."""
    pages: list[dict] = []
    for url in urls:
        try:
            status, content_type, body = await transport(url, {"Accept": "text/html"})
            pages.append(
                {
                    "url": url,
                    "status": status,
                    "content_type": content_type,
                    "text": body[:LIVE_PAGE_CHARS],
                    "truncated": len(body) > LIVE_PAGE_CHARS,
                    "error": None,
                }
            )
        except Exception as exc:  # noqa: BLE001
            pages.append(
                {
                    "url": url,
                    "status": None,
                    "content_type": None,
                    "text": "",
                    "truncated": False,
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
    return pages


# ---------------------------------------------------------------------------
# The pass itself
# ---------------------------------------------------------------------------


def run_code_pass(
    *, task_sheet: TaskSheet, answer: str, citations: list[Citation], sources_found: bool
) -> CodePass:
    """Mark every code-checked point on this sheet."""
    results = [
        _mark_point(point, answer=answer, citations=citations, sources_found=sources_found)
        for point in task_sheet.points
    ]
    return CodePass(citations=citations, points=results, sources_section_found=sources_found)


def _mark_point(
    point: Point, *, answer: str, citations: list[Citation], sources_found: bool
) -> PointResult:
    if not point.code_checked:
        return PointResult(point.id, point.checks, NOT_CODE_CHECKED, ["judge-checked point"])

    reasons: list[str] = []
    awarded = True

    if point.citation_mechanics:
        if not citations:
            awarded = False
            reasons.append(
                "no Sources list in the answer" if not sources_found else "Sources list holds no URLs"
            )
        for citation in citations:
            if not citation.served_in_run:
                awarded = False
                reasons.append(f"cited but not served in the run's fetch log: {citation.url}")
            if not citation.resolves:
                awarded = False
                reasons.append(
                    f"does not resolve at marking time ({citation.live_error or citation.live_status}): "
                    f"{citation.url}"
                )

    if point.citation_hosts:
        for citation in citations:
            host = (urlsplit(citation.url).hostname or "").lower()
            host = host[4:] if host.startswith("www.") else host
            if host not in point.citation_hosts:
                awarded = False
                reasons.append(
                    f"cited host {host or 'unknown'} is not one of "
                    f"{', '.join(point.citation_hosts)}: {citation.url}"
                )

    if point.citation_allowlist:
        matches = [citation for citation in citations if _on_allowlist(citation.url, point.citation_allowlist)]
        sound = [citation for citation in matches if citation.sound]
        if sound:
            reasons.append(f"allowed citation served in the run: {sound[0].url}")
        elif matches:
            awarded = False
            reasons.append(
                f"allowed citation {matches[0].url} was not served in the run's fetch log or does "
                "not resolve"
            )
        else:
            awarded = False
            reasons.append("no cited URL matches this point's allowed list")

    if point.required_strings:
        haystack = answer.lower()
        for group in point.required_strings:
            hit = next((item for item in group if item.lower() in haystack), None)
            if hit is None:
                awarded = False
                reasons.append(f"none of {list(group)} appears in the answer")
            else:
                reasons.append(f"found {hit!r} in the answer")

    return PointResult(point.id, point.checks, AWARDED if awarded else REFUSED, reasons)
