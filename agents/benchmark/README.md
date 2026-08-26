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
   `DEEPSEEK_API_KEY` for `deepseek:*` (the default), `GOOGLE_API_KEY` for `google:*` (Gemini),
   `ANTHROPIC_API_KEY` for `anthropic:*`. The runner reads the key from the environment, so export
   it before running:

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

3. Read the artifacts under `runs\<date>-<route>-<model>-<hhmmss>\`, for example
   `runs\2026-08-25-c-deepseek-v4-flash-141530\`. Every run gets its own directory: keying them by
   date and route alone let a second run silently overwrite the first.

   | File | What it holds |
   |---|---|
   | `task-<n>-answer.md` | The agent's final answer. |
   | `task-<n>-events.jsonl` | The harness AgentEvent stream for the turn, one event per line. |
   | `task-<n>-fetches.jsonl` | Every request the agent attempted: URL, status, bytes, served or refused, and the refusal reason. |
   | `task-<n>-run.json` | The run's mechanics: model, budgets, wall time, token totals, fetch counts. |

Useful flags: `--model`, `--max-fetches`, `--max-bytes`, `--wall-seconds`, `--token-budget`,
`--model-activity-seconds`, `--thinking`, `--address`, `--namespace`, `--temporal-api-key`,
`--pack`, `--out`. Budgets must be identical across routes within one benchmark run, so change them
for the whole run or not at all.

## Choosing a model

`--model` takes a Pydantic AI model string and is the only thing that has to change to swap
providers; the key check follows the prefix and names the key the chosen model needs.

| Flag | Key |
|---|---|
| `--model deepseek:deepseek-v4-flash` (default) | `DEEPSEEK_API_KEY` |
| `--model google:gemini-3.5-flash` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| `--model anthropic:claude-sonnet-5` | `ANTHROPIC_API_KEY` |

Runs are non-thinking by default. Deepseek V4 thinks unless told not to, and thinking tokens are
billed as output tokens, so leaving thinking on would inflate the output-token metric without
changing the answer being marked. `--thinking on` turns it back on for models that support it, and
every `run.json` records which mode produced it.

## Budgets that end a run

A run stops when it spends `--token-budget` tokens in total (default 2,000,000; `0` disables it).
That is a kill-switch rather than a research variable: it is set well above the largest run
observed, so it ends a loop that will never finish and leaves a run that would have finished alone.
Exhausting it is a recorded outcome, not a crash — the run writes its three artifact files with
`failure` set in `run.json` and exits non-zero.

`--model-activity-seconds` is the StartToClose timeout on one model request (default 300). The
Pydantic AI default of 60 seconds is shorter than a slow model's first token, and Temporal retries
a timed-out activity, so the run pays for the same request several times before it completes.

## Running on Temporal Cloud

Set `TEMPORAL_API_KEY` (or pass `--temporal-api-key`) along with `--address` and `--namespace`, and
the run connects to Cloud over TLS instead of the local dev server. The worker is still local: only
the server moves.

```powershell
$env:TEMPORAL_API_KEY = "<key>"
uv run benchmark-run --task 1 --route c `
  --address "<namespace>.<account>.tmprl.cloud:7233" --namespace "<namespace>.<account>"
```

With no API key set the runner uses `localhost:7233`, which stays the default and the debug path.
Each `run.json` records which of the two it ran against. If your `.env.local` points `TEMPORAL_ADDRESS`
at Cloud, going back to the dev server for one run takes both overrides:

```powershell
uv run benchmark-run --task 1 --route c --address localhost:7233 --namespace default --temporal-api-key ""
```

A remote address with no API key is refused before the run starts. Connecting to a TLS endpoint in
plaintext is answered with a connection reset, and the error that surfaces names neither the
address nor the missing key.

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
