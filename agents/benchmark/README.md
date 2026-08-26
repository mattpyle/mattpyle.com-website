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
   `ANTHROPIC_API_KEY` for `anthropic:*`. Every command reads `.env.local` itself at start, so
   there is nothing to export. A variable already set in the shell always wins, which is how you
   override one setting for one run:

   ```powershell
   $env:TEMPORAL_ADDRESS = "localhost:7233"   # beats whatever .env.local says, for this shell
   ```

   Set `BENCHMARK_ENV_FILE` to read a different file, or to a path that does not exist to read
   none.

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

## Running the whole benchmark

`benchmark-batch` runs every task on every route, N repeats each, one run at a time, and records
every cell in a manifest. Runs are sequential on purpose: one process is one run, so cells cannot
share a worker.

```powershell
uv run benchmark-batch --repeats 5
```

| Flag | What it does |
|---|---|
| `--tasks`, `--routes`, `--repeats` | The plan. Defaults to tasks 1-5, routes a,b,c, 5 repeats: 75 runs. |
| `--manifest` | Where the manifest is written, or an existing one to resume. |
| `--retry-failed` | Also re-run the cells the manifest records as failed. |
| `--dry-run` | Print the cells that would run and run nothing. |
| `--model`, `--pack`, `--address`, `--namespace`, and every budget flag | Passed to each run. |
| `--temporal-api-key` | Given to each run through its environment, never on its command line. |

A cell that fails is an outcome, not an abort: the manifest records the failure and the batch
carries on. Pointed at an existing manifest, the batch runs only the cells that have no outcome,
so a batch killed halfway resumes where it stopped and one re-run against a finished manifest does
nothing. A resumed batch keeps the model and budget flags its first cells ran under, because a
result whose cells did not all run the same way is not comparable; naming a different one on the
command line works, and says so in the output.

The Temporal API key is never written to the manifest. Supply it the same way on a resume, from
`.env.local` or `--temporal-api-key`.

Marking is a separate command. The batch runner never calls a judge.

## Marking a run

`benchmark-mark` marks run directories against the marking sheet in two passes:

1. **The code pass**, always. It parses the answer's Sources list, checks every cited URL against
   that run's fetch log, fetches each one again at marking time to record whether it still
   resolves, and checks the sheet's allowed-citation lists and required strings. Deterministic, and
   never overridden by the judge.
2. **The judge pass**, one blind model call per task per run. The judge sees the task prompt, the
   judge-checked points, the answer, the code pass's citation findings, and the pages the sheet
   pins, fetched at marking time. It never sees the route, the model, the run directory's name, or
   any token count.

```powershell
uv run benchmark-mark runs\2026-08-25-c-deepseek-v4-flash-213432
uv run benchmark-mark runs\2026-08-24-a runs\2026-08-24-b runs\2026-08-24-c --summary calibration.md
```

| Flag | What it does |
|---|---|
| `--sheet` | The marking sheet file (default: `docs/reference/benchmark-marking-sheet-temporal-v1.yaml`, or `BENCHMARK_MARKING_SHEET`). |
| `--judge-prompt` | The judge prompt template (default: `docs/reference/benchmark-judge-prompt-v1.md`, or `BENCHMARK_JUDGE_PROMPT`). |
| `--judge-model` | Which model marks. Defaults to the same cheap model runs use; the audition passes its own. |
| `--no-judge` | Code pass only. |
| `--summary` | Write the per-answer, per-point table calibration compares against hand marks. |
| `--task`, `--pack` | Mark one task; read prompts from a pack elsewhere. |

Marking writes `task-<n>-marking.json` beside the run's other artifacts: both passes' verdicts, the
judge's justifications, its token usage and cost, the rendered judge call itself, and the path and
content hash of both the sheet and the prompt file that produced the mark. Any command that calls
the judge prints the total judge cost at the end; `--no-judge` has none to print.

A Sources list is model output, so the marker treats it as a list of requests a stranger asked it
to make. It fetches at most the first 20 cited URLs, https only, never at an address that is not on
the public internet, and reads at most 400 KB of any one response. A URL it will not follow is
recorded in `marking.json` with the reason and counts as unresolved, exactly like one that 404s.
For the same reason the answer reaches the judge as fenced data, and a placeholder or a forged
heading written inside an answer stays inside it.

Both input files live with the task pack and are read at run time, never embedded here: a marking
criterion is vault material like a task prompt, and freezing a prompt after calibration is then an
edit to a file rather than a change to this code. The sheet's structure — which points are
code-checked, the allowed citation lists, the required strings — is documented in its own header
comment.

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
| `benchmark/envfile.py` | Reads `.env.local` at CLI start, never over a variable the shell already set. |
| `benchmark/marking_sheet.py` | Reads the machine-readable marking sheet, and refuses one it cannot mark from. |
| `benchmark/marking.py` | The code pass: the Sources list, the fetch log, the live check, the sheet's deterministic rules. Model-free and network-injected. |
| `benchmark/judge.py` | What the judge sees, and the one call that sends it. Blindness is a property of what this file renders. |
| `benchmark/mark_cli.py` | Marking: both passes, `marking.json`, the calibration table, the cost line. |
| `benchmark/batch_cli.py` | The batch: the plan, the manifest, resume, and one subprocess per cell. |

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

Reporting. A batch produces runs and a marking produces scores; turning those into the benchmark's
comparison between routes is a separate step.
