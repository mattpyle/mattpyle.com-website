# ABOUTME: The judge pass: one blind model call per task per run.
#
# The judge sees the task prompt, the judge-visible points of that task's sheet, the answer, the
# code pass's citation findings, and the pages fetched at marking time. It never sees the route,
# the model that produced the answer, the run directory's name, or any token count — blindness is
# a property of what this module renders, and a test asserts it.
#
# The prompt template is a file passed by path, so the architect can freeze the wording that
# survives calibration without touching this code.

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from .marking import CodePass, NOT_CODE_CHECKED
from .marking_sheet import TaskSheet

__all__ = [
    "JudgePrompt",
    "JudgeVerdict",
    "JudgeResult",
    "load_judge_prompt",
    "render_judge_input",
    "call_judge",
    "default_judge_prompt_path",
    "estimate_cost",
    "normalise_point_id",
]

JUDGE_PROMPT_RELATIVE_PATH = "docs/reference/benchmark-judge-prompt-v1.md"

PLACEHOLDERS = (
    "task_prompt",
    "marking_sheet",
    "answer",
    "citation_verdicts",
    "live_pages",
)


def default_judge_prompt_path() -> Path:
    import os

    from_env = os.environ.get("BENCHMARK_JUDGE_PROMPT")
    if from_env:
        return Path(from_env).expanduser()
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / JUDGE_PROMPT_RELATIVE_PATH


@dataclass(frozen=True)
class JudgePrompt:
    path: Path
    sha256: str
    template: str

    def identity(self) -> dict[str, str]:
        return {"path": str(self.path), "sha256": self.sha256}


def load_judge_prompt(path: Path | None = None) -> JudgePrompt:
    file_path = path or default_judge_prompt_path()
    if not file_path.is_file():
        raise SystemExit(
            f"judge prompt not found at {file_path}. Set BENCHMARK_JUDGE_PROMPT to its location."
        )
    raw = file_path.read_bytes()
    template = raw.decode("utf-8")
    missing = [name for name in PLACEHOLDERS if f"{{{{{name}}}}}" not in template]
    if missing:
        raise SystemExit(
            f"judge prompt {file_path} is missing placeholders: {', '.join(missing)}"
        )
    return JudgePrompt(
        path=file_path, sha256=hashlib.sha256(raw).hexdigest(), template=template
    )


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_marking_sheet(task_sheet: TaskSheet, code_pass: CodePass) -> str:
    """The points the judge marks, and what the code pass already found for each.

    Code-only points are left out entirely: the judge does not re-mark them, and showing them
    invites it to.
    """
    found = {result.point_id: result for result in code_pass.points}
    blocks: list[str] = []
    for point in task_sheet.points:
        if not point.judge_checked:
            continue
        lines = [f"### Point {point.id}", point.text]
        result = found.get(point.id)
        if point.code_checked and result is not None and result.verdict != NOT_CODE_CHECKED:
            lines.append(
                f"Code pass (presence only, already settled): {result.verdict}. "
                + "; ".join(result.reasons)
            )
            lines.append(
                "Your job on this point is correctness, not presence: award it only if the answer "
                "uses the name for what it actually is."
            )
        if point.requires_justification:
            lines.append(
                "This is a reasoning point. Your justification line is read by a person, so make "
                "it say what in the answer decided it."
            )
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) or "(no judge-checked points on this sheet)"


def render_citation_verdicts(code_pass: CodePass) -> str:
    if not code_pass.citations:
        return (
            "The answer cited nothing."
            if code_pass.sources_section_found
            else "The answer has no Sources list."
        )
    lines = []
    for citation in code_pass.citations:
        served = "fetched during the run" if citation.served_in_run else "NOT fetched during the run"
        if citation.skipped_reason:
            live = f"not checked at marking time: {citation.skipped_reason}"
        elif citation.live_error:
            live = f"unreachable at marking time ({citation.live_error})"
        else:
            live = f"HTTP {citation.live_status} at marking time"
        # The URL came out of the answer, so it goes in as quoted data on one line: backticked,
        # and with anything that could start a line of its own stripped out.
        lines.append(f"- `{_one_line(citation.url)}` — {served}; {live}")
    return "\n".join(lines)


def _one_line(text: str, limit: int = 300) -> str:
    """One line of quoted data: no newlines, no backticks to close the quote with, and bounded."""
    flattened = " ".join(text.split()).replace("`", "'")
    return flattened if len(flattened) <= limit else flattened[:limit] + "..."


def render_live_pages(pages: list[dict]) -> str:
    if not pages:
        return "(no pages pinned for comparison on this task)"
    blocks = []
    for page in pages:
        if page.get("error"):
            blocks.append(f"### {page['url']}\nCould not be fetched at marking time: {page['error']}")
            continue
        note = " (truncated)" if page.get("truncated") else ""
        blocks.append(
            f"### {page['url']}\nHTTP {page.get('status')}{note}\n\n{page.get('text', '')}"
        )
    return "\n\n".join(blocks)


def render_judge_input(
    *,
    prompt: JudgePrompt,
    task_prompt: str,
    task_sheet: TaskSheet,
    answer: str,
    code_pass: CodePass,
    live_pages: list[dict],
) -> str:
    """Fill the template. Nothing reaches the judge that this function does not put there.

    Every placeholder is substituted in one pass. Filling them one at a time meant an answer
    containing the literal text `{{citation_verdicts}}` had it expanded by a later iteration, so
    the answer could forge the block that tells the judge which citations are sound. `re.sub`
    with a function never rescans what it inserted, so a placeholder inside the answer reaches the
    judge as the literal text the answer wrote.
    """
    values = {
        "task_prompt": task_prompt,
        "marking_sheet": render_marking_sheet(task_sheet, code_pass),
        "answer": _fence_safe(answer.strip()),
        "citation_verdicts": render_citation_verdicts(code_pass),
        "live_pages": render_live_pages(live_pages),
    }
    return _PLACEHOLDER.sub(lambda match: values.get(match.group(1), match.group(0)), prompt.template)


_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")

# The template fences the answer between these, and names the fence as data. An answer that wrote
# one of them itself would end the fence early and put the rest of its text back in the prompt's
# own voice, so a marker written inside the answer is quoted before it goes in. This bites only an
# answer that contains the marker, which no answer to these tasks does.
_FENCE_MARKERS = ("ANSWER-START", "ANSWER-END")


def _fence_safe(answer: str) -> str:
    for marker in _FENCE_MARKERS:
        answer = answer.replace(marker, f"[quoted from the answer: {marker}]")
    return answer


# ---------------------------------------------------------------------------
# The call
# ---------------------------------------------------------------------------


@dataclass
class JudgeVerdict:
    point_id: str
    awarded: bool
    justification: str

    def as_dict(self) -> dict:
        return {
            "id": self.point_id,
            "awarded": self.awarded,
            "justification": self.justification,
        }


def normalise_point_id(point_id: str) -> str:
    """The join key for a point id, tolerant of how the judge writes it back.

    The prompt renders each criterion as `### Point 1.2`, so the judge often returns
    `"Point 1.2"` rather than `"1.2"`. Rather than fight the prompt, which is frozen and hashed
    into every marking.json, the harness normalises both sides before joining: it drops a leading
    `point` label, surrounding punctuation and case, and the leading zeros a model sometimes pads
    a segment with.
    """
    text = point_id.strip().lower()
    text = re.sub(r"^point\b[\s.:#\-]*", "", text)
    text = text.strip(" \t.:#-)(")
    segments = text.split(".")
    return ".".join(segment.lstrip("0") or "0" for segment in segments)


@dataclass
class JudgeResult:
    verdicts: list[JudgeVerdict] = field(default_factory=list)
    usage: dict = field(default_factory=dict)
    cost_usd: float | None = None
    error: str | None = None

    def as_dict(self) -> dict:
        return {
            "verdicts": [verdict.as_dict() for verdict in self.verdicts],
            "usage": dict(self.usage),
            "cost_usd": self.cost_usd,
            "error": self.error,
        }


def estimate_cost(model: str, usage: dict) -> float | None:
    """What the call cost, from the provider's published prices.

    Priced from the token counts rather than from a provider invoice, so it is an estimate: the
    audition's kill rule needs a number now, not at the end of the billing month. An unknown model
    returns None rather than a wrong number.
    """
    provider, _, name = model.partition(":")
    if not name:
        provider, name = "", model
    try:
        from genai_prices import Usage, calc_price

        price = calc_price(
            Usage(
                input_tokens=usage.get("input_tokens") or 0,
                output_tokens=usage.get("output_tokens") or 0,
                cache_read_tokens=usage.get("cache_read_tokens") or None,
                cache_write_tokens=usage.get("cache_write_tokens") or None,
            ),
            name,
            provider_id=provider or None,
        )
        return float(price.total_price)
    except Exception:  # noqa: BLE001 - an unpriced model is a null cost, not a failed marking
        return None


async def call_judge(model: str, judge_input: str) -> JudgeResult:
    """One real model call. Injected into the marker, so every test runs without one."""
    from pydantic import BaseModel
    from pydantic_ai import Agent

    class _Verdict(BaseModel):
        id: str
        awarded: bool
        justification: str

    class _Verdicts(BaseModel):
        points: list[_Verdict]

    agent = Agent(model, output_type=_Verdicts)
    result = await agent.run(judge_input)
    # `usage` is a property on this version of Pydantic AI, not the callable older code expects.
    usage = result.usage
    usage_dict = {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "cache_read_tokens": usage.cache_read_tokens,
        "cache_write_tokens": usage.cache_write_tokens,
        "requests": usage.requests,
    }
    return JudgeResult(
        verdicts=[
            JudgeVerdict(point_id=point.id, awarded=point.awarded, justification=point.justification)
            for point in result.output.points
        ],
        usage=usage_dict,
        cost_usd=estimate_cost(model, usage_dict),
    )
