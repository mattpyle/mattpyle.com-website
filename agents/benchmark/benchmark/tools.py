# ABOUTME: The harness adapter for the fetch tool — the only file that knows about both the fetch
# module and temporal-agent-harness. It is an activity-backed tool because a fetch is network I/O,
# which a Temporal workflow may not do; the workflow dispatches it and the worker runs it.
#
# Keeping this file thin is the point: replacing the harness means rewriting this file and nothing
# in fetch.py.

from __future__ import annotations

from datetime import timedelta

from temporal_agent_harness.harness import agent
from temporalio.workflow import ActivityConfig

from .fetch import render_for_model
from .runtime import current_fetch_tool

__all__ = ["fetch_url"]


@agent.activity_tool_defn(
    inherently_safe=True,
    activity_config=ActivityConfig(start_to_close_timeout=timedelta(seconds=90)),
)
async def fetch_url(url: str) -> str:
    """Fetch one web page and return its text. `url` is a full https URL on an official Temporal
    site. Returns the page's status, content type, and body, or a refusal explaining why the URL
    could not be fetched."""
    result = await current_fetch_tool().fetch(url)
    return render_for_model(result)
