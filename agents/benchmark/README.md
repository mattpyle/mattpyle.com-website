# Agent-task benchmark rig

An observational benchmark of what a website's agent-facing surfaces are worth. An agent is given
one realistic task and one entry route into temporal.io — plain HTML pages, `llms.txt` as the entry
point, or `llms.txt` plus the linked markdown — and a fetch tool that enforces that route. Each run
records the answer, the agent's event stream, and every request it made, so the routes can be
compared on outcomes rather than on whether a file exists. The agent runs as a Temporal workflow via
[temporal-agent-harness](https://github.com/temporal-community/temporal-agent-harness), so a run is
durable and its whole history is inspectable after the fact.

## The three routes

| Route | Entry URL | `llms.txt` | Markdown (`.md`) | HTML |
|---|---|---|---|---|
| `a` | `https://temporal.io/` | refused | refused | served |
| `b` | `https://temporal.io/llms.txt` | served | refused | served |
| `c` | `https://temporal.io/llms.txt` | served | served | served |

Every route sends `Accept: text/html`, reaches only `temporal.io`, `docs.temporal.io`,
`learn.temporal.io` and `github.com/temporalio/*`, and runs under the same budgets. There is no web
search tool: the site's own surfaces are the thing being measured. The task prompt is identical
across routes — the entry URL is configuration, not part of the prompt.

## Setup

1. Install [uv](https://docs.astral.sh/uv/) and the [Temporal CLI](https://docs.temporal.io/cli).
2. Install dependencies:

   ```powershell
   cd agents\benchmark
   uv sync
   ```

3. Copy `.env.example` to `.env.local` and set the key for your model's provider:
   `ANTHROPIC_API_KEY` for `anthropic:*` models, `GOOGLE_API_KEY` for `google:*` (Gemini)
   models. The runner reads the key from the environment, so export it before running:

   ```powershell
   Get-Content .env.local | Where-Object { $_ -match '^\w+=' } | ForEach-Object {
     $name, $value = $_ -split '=', 2
     Set-Item -Path "env:$name" -Value $value
   }
   ```

4. Point the runner at the task pack. It defaults to
   `docs/reference/benchmark-task-pack-temporal-v1.md` in this repository; set
   `BENCHMARK_TASK_PACK` to use a copy elsewhere. Prompts are read from that file at run time and
   are never embedded in this code.

## Running one task on one route

1. Start a local Temporal dev server in its own terminal:

   ```powershell
   temporal server start-dev
   ```

2. Run the task:

   ```powershell
   cd agents\benchmark
   uv run benchmark-run --task 1 --route a
   ```

3. Read the artifacts under `runs\<date>-<route>\`:

   | File | What it holds |
   |---|---|
   | `task-<n>-answer.md` | The agent's final answer. |
   | `task-<n>-events.jsonl` | The harness AgentEvent stream for the turn, one event per line. |
   | `task-<n>-fetches.jsonl` | Every request the agent attempted: URL, status, bytes, served or refused, and the refusal reason. |
   | `task-<n>-run.json` | The run's mechanics: model, budgets, wall time, token totals, fetch counts. |

Useful flags: `--model`, `--max-fetches`, `--max-bytes`, `--wall-seconds`, `--address`,
`--namespace`, `--pack`, `--out`. Budgets must be identical across routes within one benchmark run,
so change them for the whole run or not at all.

## How it is put together

| File | Role |
|---|---|
| `benchmark/fetch.py` | The condition-enforcing fetch tool: allowlist, route rules, budgets, JSONL log. Imports nothing from the harness. |
| `benchmark/routes.py` | The three routes and the shared budgets. Also harness-free. |
| `benchmark/task_pack.py` | Reads one task's prompt out of the frozen pack at run time. Reads the prompt only, never the marking sheet. |
| `benchmark/runtime.py` | The run's settings, read from the environment, and the agent's standing instructions. |
| `benchmark/tools.py` | The harness adapter — the one file that knows about both the fetch tool and the harness. |
| `benchmark/workflow.py` | The agent workflow, driven by Pydantic AI through the harness. |
| `benchmark/cli.py` | One run: hosts a worker, starts the workflow, streams the turn to disk, writes the artifacts. |

`fetch.py` is deliberately independent of the harness so the rules survive a change of rig: if the
harness is replaced by a plain agent loop, this file moves across unchanged and only `tools.py` is
rewritten. Its tests run with no harness, no model, and no network:

```powershell
cd agents\benchmark
uv run pytest
```

Two things worth knowing before changing the rig:

- **One process is one run.** The fetch tool keeps its counters — fetches used, the wall-time clock
  — in the worker process, and the process sets up its route from the environment before the
  workflow module is imported. Two concurrent runs need two processes, not one worker serving both.
- **A refusal costs no fetch budget.** Refusals never reach the network, so they do not spend
  `--max-fetches`. What a refusal costs the agent is a turn, which is exactly the cost the routes
  should differ on.

## What this does not do yet

Scoring. A run produces artifacts; marking them against the pack's sheets, and anything that could
be called a benchmark result, is a separate step.
