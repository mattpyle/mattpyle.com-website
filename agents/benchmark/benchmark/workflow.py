# ABOUTME: The benchmark agent as a Temporal workflow, driven by Pydantic AI through
# temporal-agent-harness. One handler, `ask`, takes the task prompt and returns the answer; the
# harness publishes the AgentEvent stream the run artifacts are built from.
#
# Shape follows the harness's own pydantic_ai_hello example: the TemporalAgent is built once at
# module load (its activities are registered on the worker by AgentPlugin) and the per-turn runner
# is threaded explicitly through `deps`, never read off the workflow instance.

from __future__ import annotations

from temporalio import workflow
from temporalio.contrib.workflow_streams import WorkflowStream

with workflow.unsafe.imports_passed_through():
    from pydantic_ai import Agent
    from pydantic_ai.durable_exec.temporal import TemporalAgent
    from pydantic_ai.messages import ModelMessage

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

_TEMPORAL_AGENT = TemporalAgent(
    Agent(
        _SETTINGS.model,
        instructions=system_prompt(_SETTINGS),
        deps_type=HarnessDeps,
        toolsets=[_TOOLSET],
    ),
    name=AGENT_NAME,
    event_stream_handler=harness_event_stream_handler,
    tool_activity_config=_TOOL_CONFIG,
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
        result = await _TEMPORAL_AGENT.run(
            message.text,
            deps=HarnessDeps(runner=self._runner),
            message_history=self._history,
        )
        self._history = result.all_messages()
        # `usage` is a property on pydantic-ai 2.34 and was a method on earlier versions; accept
        # either rather than pinning the rig to one of them.
        usage = result.usage
        if callable(usage):
            usage = usage()
        return BenchmarkAnswer(
            text=str(result.output),
            input_tokens=getattr(usage, "input_tokens", None),
            output_tokens=getattr(usage, "output_tokens", None),
            total_tokens=getattr(usage, "total_tokens", None),
            model_requests=getattr(usage, "requests", None),
        )
