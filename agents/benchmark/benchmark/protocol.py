# ABOUTME: The reply the benchmark agent returns — the answer plus the run's token spend.
#
# Token counts are one of the metrics this benchmark reports, and the harness's streamed
# `model_interaction_ended` events carry `usage: null` on the Pydantic AI path (observed
# 2026-08-24, harness e71a569, pydantic-ai 2.34.0). Pydantic AI's own run result reports usage
# reliably, so the workflow reads it there and returns it with the answer.

from __future__ import annotations

from pydantic import BaseModel

__all__ = ["BenchmarkAnswer"]


class BenchmarkAnswer(BaseModel):
    """The agent's answer to one task, with what the run cost in tokens."""

    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    model_requests: int | None = None
    # A run that runs out of token budget is a scoreable outcome, not a crash: the turn still
    # replies, carrying whatever tokens were spent and the reason it stopped, so the run writes
    # its three artifact files like any other run and the marking sheet can see what happened.
    failure: str | None = None
