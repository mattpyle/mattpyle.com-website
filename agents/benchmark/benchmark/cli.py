# ABOUTME: Runs one benchmark task on one route and writes the run's artifacts.
#
# The process is the run: it sets the run's environment, hosts a worker for exactly this run,
# starts the agent workflow, streams the turn's AgentEvents to disk, saves the answer, and stops.
# Nothing survives between runs, which is why the fetch tool can keep its counters in memory.
#
#     uv run benchmark-run --task 1 --route a

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path

from .routes import (
    DEFAULT_BUDGETS,
    DEFAULT_MODEL_ACTIVITY_SECONDS,
    DEFAULT_TOKEN_BUDGET,
    route_by_name,
)
from .runtime import DEFAULT_MODEL, model_slug
from .task_pack import load_task

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="benchmark-run",
        description="Run one task pack task on one entry route and save the run artifacts.",
    )
    parser.add_argument("--task", type=int, required=True, help="task number in the pack")
    parser.add_argument(
        "--route", required=True, choices=["a", "b", "c"], help="entry route to run"
    )
    parser.add_argument(
        "--pack", type=Path, default=None, help="path to the task pack markdown file"
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=PROJECT_ROOT / "runs",
        help="directory run folders are written under (default: ./runs)",
    )
    parser.add_argument(
        "--address",
        default=os.environ.get("TEMPORAL_ADDRESS", "localhost:7233"),
        help="Temporal server address (default: localhost:7233)",
    )
    parser.add_argument(
        "--namespace", default=os.environ.get("TEMPORAL_NAMESPACE", "default")
    )
    parser.add_argument(
        "--temporal-api-key",
        default=os.environ.get("TEMPORAL_API_KEY", ""),
        help=(
            "Temporal Cloud API key. Set it (or TEMPORAL_API_KEY) to run against Cloud; leave it "
            "unset to use the local dev server."
        ),
    )
    parser.add_argument("--model", default=os.environ.get("BENCHMARK_MODEL"))
    parser.add_argument("--max-fetches", type=int, default=DEFAULT_BUDGETS.max_fetches)
    parser.add_argument(
        "--max-bytes", type=int, default=DEFAULT_BUDGETS.max_bytes_per_response
    )
    parser.add_argument(
        "--wall-seconds", type=float, default=DEFAULT_BUDGETS.wall_time_seconds
    )
    parser.add_argument(
        "--token-budget",
        type=int,
        default=DEFAULT_TOKEN_BUDGET,
        help=(
            "total tokens one run may spend before it stops and records budget exhaustion; "
            "0 disables the limit (default: %(default)s)"
        ),
    )
    parser.add_argument(
        "--model-activity-seconds",
        type=float,
        default=DEFAULT_MODEL_ACTIVITY_SECONDS,
        help=(
            "StartToClose timeout for one model request activity; raise it for models with a slow "
            "first token (default: %(default)s)"
        ),
    )
    parser.add_argument(
        "--thinking",
        choices=["off", "on"],
        default="off",
        help=(
            "whether the model may spend thinking tokens; off keeps them out of the output-token "
            "metric (default: %(default)s)"
        ),
    )
    return parser.parse_args(argv)


LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})


def _temporal_address_problem(address: str, api_key: str) -> str | None:
    """Refuse a remote address with no API key, naming both causes.

    Without the key the client connects in plaintext, and a TLS endpoint answers that by resetting
    the connection: the failure that reaches the operator is a `transport error` from deep inside
    the Rust bridge, which names neither the address nor the missing key. Steward's client refuses
    the same combination for the same reason.
    """
    if (api_key or "").strip():
        return None
    host = address.split("]")[0] + "]" if address.startswith("[") else address.split(":")[0]
    if host in LOOPBACK_HOSTS:
        return None
    return (
        f"TEMPORAL_ADDRESS is {address}, which is not the local dev server, but no Temporal API "
        "key is set. Put TEMPORAL_API_KEY in agents/benchmark/.env.local and export it, pass "
        "--temporal-api-key, or point --address back at localhost:7233."
    )


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    # The key requirement follows the model's provider prefix (PydanticAI model strings,
    # e.g. "deepseek:deepseek-v4-flash", "google:gemini-3.5-flash", "anthropic:claude-sonnet-5").
    # Switching models is this one flag; nothing else in the rig names a provider.
    model = args.model or os.environ.get("BENCHMARK_MODEL") or DEFAULT_MODEL
    if model.startswith("deepseek"):
        required_key = "DEEPSEEK_API_KEY"
        key_present = os.environ.get("DEEPSEEK_API_KEY")
    elif model.startswith("google"):
        required_key = "GOOGLE_API_KEY"
        key_present = os.environ.get("GOOGLE_API_KEY") or os.environ.get(
            "GEMINI_API_KEY"
        )
    else:
        required_key = "ANTHROPIC_API_KEY"
        key_present = os.environ.get("ANTHROPIC_API_KEY")
    if not key_present:
        print(
            f"error: {required_key} is not set for model {model}. Put it in "
            "agents/benchmark/.env.local and export it, or set it in the shell.",
            file=sys.stderr,
        )
        return 2

    address_problem = _temporal_address_problem(args.address, args.temporal_api_key)
    if address_problem:
        print(f"error: {address_problem}", file=sys.stderr)
        return 2

    route = route_by_name(args.route)
    task = load_task(args.task, args.pack)

    # Date, route, model and time of day, because date-plus-route alone let a second run
    # overwrite the first: that is how the 2026-08-24 Sonnet route C artifacts were lost.
    started_at = datetime.now().astimezone()
    run_dir = args.out / (
        f"{started_at.date().isoformat()}-{route.name}-{model_slug(model)}-"
        f"{started_at.strftime('%H%M%S')}"
    )
    run_dir.mkdir(parents=True, exist_ok=True)
    prefix = f"task-{task.number}"
    fetch_log = run_dir / f"{prefix}-fetches.jsonl"
    events_log = run_dir / f"{prefix}-events.jsonl"
    answer_path = run_dir / f"{prefix}-answer.md"
    summary_path = run_dir / f"{prefix}-run.json"

    # The fetch tool appends, so the run owns the file's lifecycle. Create it empty rather than
    # leaving it to the first fetch: a run that ends before it fetches anything still owes the
    # three artifact files its run.json names, and an empty log is the honest record of no fetches.
    fetch_log.write_text("", encoding="utf-8")

    # Set the run's environment BEFORE the workflow module is imported: it reads these at import
    # to build its agent, and the worker below imports it.
    os.environ["BENCHMARK_ROUTE"] = route.name
    os.environ["BENCHMARK_FETCH_LOG"] = str(fetch_log)
    os.environ["BENCHMARK_MAX_FETCHES"] = str(args.max_fetches)
    os.environ["BENCHMARK_MAX_BYTES"] = str(args.max_bytes)
    os.environ["BENCHMARK_WALL_SECONDS"] = str(args.wall_seconds)
    os.environ["BENCHMARK_TOKEN_BUDGET"] = str(args.token_budget)
    os.environ["BENCHMARK_MODEL_ACTIVITY_SECONDS"] = str(args.model_activity_seconds)
    os.environ["BENCHMARK_THINKING"] = "on" if args.thinking == "on" else "off"
    os.environ["BENCHMARK_MODEL"] = model

    return asyncio.run(
        _run(
            args=args,
            route_name=route.name,
            task=task,
            run_dir=run_dir,
            fetch_log=fetch_log,
            events_log=events_log,
            answer_path=answer_path,
            summary_path=summary_path,
            started_at=started_at,
        )
    )


async def _run(
    *,
    args: argparse.Namespace,
    route_name: str,
    task,
    run_dir: Path,
    fetch_log: Path,
    events_log: Path,
    answer_path: Path,
    summary_path: Path,
    started_at: datetime,
) -> int:
    # Imported here, not at module load: the workflow module reads the run's environment at import.
    from pydantic_ai.durable_exec.temporal import AgentPlugin, PydanticAIPlugin
    from temporal_agent_harness.harness.agent_client import (
        AgentClient,
        AgentTurnError,
        AgentTurnTimeout,
    )
    from temporal_agent_harness.harness.agent_protocol import (
        AgentConfig,
        AgentEvent,
        AgentEventType,
    )
    from temporalio.client import Client
    from temporalio.worker import Worker

    from .runtime import current_settings
    from .tools import fetch_url
    from .workflow import TASK_QUEUE, BenchmarkAgentWorkflow, _TEMPORAL_AGENT
    from temporal_agent_harness.harness import agent as harness_agent

    settings = current_settings()
    route = settings.route

    # Temporal Cloud when an API key is set, the local dev server otherwise. The key implies TLS,
    # and `temporal-namespace` is redundant against a namespace endpoint but not free to omit:
    # without it, API-key auth against a regional endpoint fails with a bare `Request
    # unauthorized` that names nothing. Steward's client makes the same call for the same reason.
    api_key = (args.temporal_api_key or "").strip()
    connect_kwargs: dict = {"namespace": args.namespace, "plugins": [PydanticAIPlugin()]}
    if api_key:
        connect_kwargs["api_key"] = api_key
        connect_kwargs["tls"] = True
        connect_kwargs["rpc_metadata"] = {"temporal-namespace": args.namespace}
    client = await Client.connect(args.address, **connect_kwargs)

    worker = Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[BenchmarkAgentWorkflow],
        activities=[harness_agent.tool_activity(fetch_url)],
        plugins=[AgentPlugin(_TEMPORAL_AGENT)],
    )

    workflow_id = f"benchmark-{route.name}-task{task.number}-{uuid.uuid4().hex[:8]}"
    target = "Temporal Cloud" if api_key else "local dev server"

    print(
        f"route {route.name} ({route.label}) | task {task.number}: {task.title}\n"
        f"entry {route.entry_url} | model {settings.model} | "
        f"thinking {'on' if settings.thinking else 'off'}\n"
        f"temporal {args.address} ({target}) | namespace {args.namespace}\n"
        f"workflow {workflow_id} | artifacts {run_dir}",
        flush=True,
    )

    events: list[AgentEvent] = []
    answer = ""
    reply: dict = {}
    failure: str | None = None

    async with worker:
        handle = await client.start_workflow(
            BenchmarkAgentWorkflow.run,
            AgentConfig(),
            id=workflow_id,
            task_queue=TASK_QUEUE,
        )
        agent_client = AgentClient(client, workflow_id)
        status = await agent_client.get_status()

        stream = await agent_client.send_message(
            "ask",
            {"text": task.prompt},
            expected_turn=status.current_turn + 1,
            on_item=lambda item, _offset: item,
            timeout=args.wall_seconds + 300.0,
        )

        with events_log.open("w", encoding="utf-8") as handle_events:
            async for item in stream:
                if isinstance(item, (AgentTurnError, AgentTurnTimeout)):
                    failure = f"{type(item).__name__}: {item}"
                    print(f"  ! {failure}", flush=True)
                    continue
                events.append(item)
                handle_events.write(
                    json.dumps(item.model_dump(mode="json"), ensure_ascii=False) + "\n"
                )
                _trace(item, AgentEventType)
                if item.event.type == AgentEventType.REPLY:
                    reply = item.event.output
                    answer = str(reply.get("text", ""))
                    # Budget exhaustion arrives on the reply, not as a turn error: the run is over
                    # and scoreable, and the artifacts below are written exactly as for any run.
                    if reply.get("failure"):
                        failure = str(reply["failure"])
                        print(f"  ! {failure}", flush=True)

        await handle.terminate(reason="benchmark run complete")

    ended_at = datetime.now().astimezone()
    answer_path.write_text(answer or "(no answer produced)\n", encoding="utf-8")

    summary = {
        "route": route.name,
        "route_label": route.label,
        "entry_url": route.entry_url,
        "task_number": task.number,
        "task_title": task.title,
        "model": settings.model,
        "workflow_id": workflow_id,
        "started_at": started_at.isoformat(),
        "ended_at": ended_at.isoformat(),
        "wall_seconds": round((ended_at - started_at).total_seconds(), 1),
        "thinking": settings.thinking,
        "temporal": {
            "address": args.address,
            "namespace": args.namespace,
            "target": "cloud" if api_key else "local-dev-server",
        },
        "budgets": {
            "max_fetches": settings.budgets.max_fetches,
            "max_bytes_per_response": settings.budgets.max_bytes_per_response,
            "wall_time_seconds": settings.budgets.wall_time_seconds,
            "total_tokens": settings.token_budget,
            "model_activity_seconds": settings.model_activity_seconds,
        },
        "failure": failure,
        "event_count": len(events),
        # Reported by Pydantic AI's own run result, carried back on the reply: the harness's
        # streamed model_interaction_ended events arrive with usage null on this path.
        "tokens": {
            "input_tokens": reply.get("input_tokens"),
            "output_tokens": reply.get("output_tokens"),
            "total_tokens": reply.get("total_tokens"),
            "model_requests": reply.get("model_requests"),
            "model_interactions": sum(
                1
                for e in events
                if e.event.type == AgentEventType.MODEL_INTERACTION_ENDED
            ),
        },
        "fetches": _fetch_totals(fetch_log),
        "artifacts": {
            "answer": answer_path.name,
            "events": events_log.name,
            "fetches": fetch_log.name,
        },
    }
    summary_path.write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(
        f"\ndone: {summary['fetches']['served']} served, "
        f"{summary['fetches']['refused']} refused, "
        f"{summary['event_count']} events, "
        f"{summary['wall_seconds']}s",
        flush=True,
    )
    return 1 if failure else 0


def _trace(event, AgentEventType) -> None:
    """One line per interesting event, so a run is watchable while it happens."""
    kind = event.event.type
    if kind == AgentEventType.TOOL_START:
        args_text = json.dumps(getattr(event.event, "tool_input", {}), ensure_ascii=False)
        print(f"  -> {event.event.tool_name} {args_text[:160]}", flush=True)
    elif kind == AgentEventType.TOOL_ERROR:
        print(f"  !! {event.event.tool_name}: {getattr(event.event, 'message', '')}", flush=True)


def _fetch_totals(fetch_log: Path) -> dict[str, object]:
    """Read the run's own fetch log back, so the summary reports what was logged rather than what
    the process believes it did."""
    served = refused = 0
    by_kind: Counter[str] = Counter()
    refusals: Counter[str] = Counter()
    if fetch_log.is_file():
        for line in fetch_log.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            record = json.loads(line)
            if record["served"]:
                served += 1
                by_kind[record["kind"]] += 1
            else:
                refused += 1
                refusals[record["refusal_reason"] or "unknown"] += 1
    return {
        "served": served,
        "refused": refused,
        "served_by_kind": dict(by_kind),
        "refusals_by_reason": dict(refusals),
    }


if __name__ == "__main__":
    raise SystemExit(main())
