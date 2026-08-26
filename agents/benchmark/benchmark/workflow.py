# ABOUTME: The benchmark agent as a Temporal workflow, driven by Pydantic AI through
# temporal-agent-harness. One handler, `ask`, takes the task prompt and returns the answer; the
# harness publishes the AgentEvent stream the run artifacts are built from.
#
# Shape follows the harness's own pydantic_ai_hello example: the TemporalAgent is built once at
# module load (its activities are registered on the worker by AgentPlugin) and the per-turn runner
# is threaded explicitly through `deps`, never read off the workflow instance.

from __future__ import annotations

import warnings
from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.contrib.workflow_streams import WorkflowStream
from temporalio.exceptions import ActivityError, ApplicationError

with workflow.unsafe.imports_passed_through():
    from pydantic_ai import Agent
    from pydantic_ai.durable_exec.temporal import TemporalAgent
    from pydantic_ai.exceptions import UsageLimitExceeded
    from pydantic_ai.messages import ModelMessage
    from pydantic_ai.settings import ModelSettings
    from pydantic_ai.usage import RunUsage, UsageLimits
    from pydantic_ai._warnings import PydanticAIDeprecationWarning

    from temporal_agent_harness.ai_sdks.pydantic_ai_harness import (
        HarnessDeps,
        build_harness_toolset,
        harness_event_stream_handler,
    )
    from temporal_agent_harness.harness import agent
    from temporal_agent_harness.harness.agent_protocol import (
        AgentConfig,
        TextMessage,
        ToolApprovalPolicy,
    )
    from temporal_agent_harness.harness.agent_workflow import AgentWorkflowRunner

    from .protocol import BenchmarkAnswer
    from .runtime import current_settings, system_prompt
    from .tools import fetch_url

TASK_QUEUE = "benchmark-agent"
AGENT_NAME = "benchmark-agent"
TOOLSET_ID = "benchmark-tools"

# Route and model come from the worker process's environment (see runtime.py): one worker process
# serves one run, so the agent it builds at import is that run's agent.
_SETTINGS = current_settings()

_TOOLSET, _TOOL_CONFIG = build_harness_toolset([fetch_url], id=TOOLSET_ID)

_TOKEN_LIMIT_ERROR = UsageLimitExceeded.__name__

# `thinking=False` is stripped by Pydantic AI for any model whose profile does not support the
# toggle, so one setting covers every provider the `--model` flag can name. On Deepseek V4 it
# becomes `reasoning_effort="none"`, which is what keeps thinking tokens out of the output count.
_MODEL_SETTINGS = ModelSettings(thinking=_SETTINGS.thinking)

# `TemporalAgent` is deprecated in pydantic-ai 2.34 in favour of
# `Agent(..., capabilities=[TemporalDurability(...)])`, but the harness's own glue module and
# examples still construct one, so the rig cannot move off it alone. Migrating is the harness's
# churn to absorb; until it does, the 12-line warning is noise in every artifact-producing run.
# See docs/inbox/harness-spike-friction.md, the 2026-08-24 additions.
with warnings.catch_warnings():
    warnings.filterwarnings(
        "ignore", message=r"`TemporalAgent` is deprecated", category=PydanticAIDeprecationWarning
    )
    _TEMPORAL_AGENT = TemporalAgent(
        Agent(
            _SETTINGS.model,
            instructions=system_prompt(_SETTINGS),
            deps_type=HarnessDeps,
            toolsets=[_TOOLSET],
            model_settings=_MODEL_SETTINGS,
        ),
        name=AGENT_NAME,
        event_stream_handler=harness_event_stream_handler,
        tool_activity_config=_TOOL_CONFIG,
        # One model request gets its own timeout: the harness default of 60 seconds is shorter than
        # a slow model's first token, and a timeout there is retried, so the run pays for the same
        # request several times over before it ever completes.
        model_activity_config={
            "start_to_close_timeout": timedelta(seconds=_SETTINGS.model_activity_seconds),
            # Pydantic AI checks the token limit workflow-side after each response, but it also
            # checks it inside the model activity while a continuation accumulates. Temporal
            # retries an activity failure forever by default, and blowing a token budget is
            # deterministic, so without this entry that path hangs the run instead of ending it.
            # Pydantic AI's own non-retryable names are merged in alongside this one.
            "retry_policy": RetryPolicy(non_retryable_error_types=[_TOKEN_LIMIT_ERROR]),
        },
    )


@workflow.defn(name="BenchmarkAgent")
@agent.defn
class BenchmarkAgentWorkflow:
    """An agent that answers one benchmark task from pages it fetches under one route's rules."""

    @workflow.init
    def __init__(self, config: AgentConfig) -> None:
        self._runner = AgentWorkflowRunner(
            config,
            stream=WorkflowStream(),
            # The run is unattended and the only tool is a read that already refuses anything off
            # the allowlist, so there is no human to gate on.
            approval_policy_default=ToolApprovalPolicy.dangerously_skip_all(),
        )
        self._history: list[ModelMessage] = []

    @workflow.run
    async def run(self, _config: AgentConfig) -> None:
        await self._runner.run(self)

    @agent.accepts
    async def ask(self, message: TextMessage) -> BenchmarkAnswer:
        """Answer one question using only pages fetched with `fetch_url`."""
        # The run accumulates into a usage object this handler owns, so the token spend is
        # readable even on the path where the limit fires and there is no result to read it off.
        usage = RunUsage()
        limits = UsageLimits(total_tokens_limit=_SETTINGS.token_budget)
        try:
            result = await _TEMPORAL_AGENT.run(
                message.text,
                deps=HarnessDeps(runner=self._runner),
                message_history=self._history,
                usage=usage,
                usage_limits=limits,
            )
        except UsageLimitExceeded as exc:
            # Scoreable, not a crash: reply with the reason and the tokens spent so the run still
            # writes its artifacts. The CLI turns a non-null `failure` into a non-zero exit.
            return _answer("", usage, failure=f"token budget exhausted: {exc}")
        except ActivityError as exc:
            # The same limit, hit inside the model activity: it reaches the workflow wrapped, so
            # unwrap before deciding, and re-raise anything that is not the token budget.
            if not _is_token_limit(exc):
                raise
            return _answer("", usage, failure=f"token budget exhausted: {exc}")

        self._history = result.all_messages()
        # `usage` is a property on pydantic-ai 2.34 and was a method on earlier versions; accept
        # either rather than pinning the rig to one of them.
        run_usage = result.usage
        if callable(run_usage):
            run_usage = run_usage()
        return _answer(str(result.output), run_usage)


def _is_token_limit(error: BaseException) -> bool:
    """True when a wrapped Temporal failure carries Pydantic AI's usage-limit error."""
    cause: BaseException | None = error
    while cause is not None:
        if isinstance(cause, ApplicationError) and cause.type == _TOKEN_LIMIT_ERROR:
            return True
        cause = cause.__cause__
    return False


def _answer(text: str, usage: object, *, failure: str | None = None) -> BenchmarkAnswer:
    return BenchmarkAnswer(
        text=text,
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        total_tokens=getattr(usage, "total_tokens", None),
        model_requests=getattr(usage, "requests", None),
        failure=failure,
    )
