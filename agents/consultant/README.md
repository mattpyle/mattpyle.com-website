# The audit consultant

A Claude-driven agent that audits a website for agent-readiness and says what matters. It runs as a Temporal workflow on [`@temporalio/agent-harness`](https://github.com/temporal-community/temporal-agent-harness), driven by Claude through the harness's Strands Agents integration.

The model decides the path: whether to audit, which tier, and when to ask the caller a question. The workflow sets the bounds.

## How it works

| Piece | File |
|---|---|
| The system prompt | `src/system-prompt.ts` |
| The agent, the tools and the caps logic (workflow code) | `src/agent.ts` |
| What a tool hands the model | `src/tools.ts`, `src/project.ts` |
| The activities: audits, the deep-audit start and wait, the close | `src/activities.ts` |
| The calls to the public MCP endpoint | `src/site.ts` |
| The cap values | `src/caps.ts` |
| The environment the worker reads | `src/config.ts` |
| The worker | `src/worker.ts` |

1. The tools reach the site only through `https://www.mattpyle.com/mcp`, the same `audit_site`, `deep_audit` and `get_audit` tools any agent calls. The client names itself `audit-consultant`.
2. A tool hands the model check ids, statuses, severities, categories and counts. No string from the audited site reaches the model: `src/project.ts` copies by allow-list and drops the rest.
3. `deep_audit` needs the caller's approval. The harness parks the call until the caller answers the `tool_approval` Update. Starting a deep audit is safe to retry: the start records the audit's id in a heartbeat, and a retried attempt reuses it.
4. A cap ends the session. Later messages get a fixed reply, `consultant_session` reports the reason, and the harness closes the agent after a grace period.

## Limits a reader must know

1. The agent's audits draw on the endpoint's public per-caller rate limit, keyed on the worker's address. Every session on one worker shares the same quota of fast and deep audits; the caps in force are on `/steward`.
2. The caps bound one session. Nothing here bounds sessions per day or total spend. That bound belongs to whatever starts sessions.

## Caps

| Cap | Default | Variable |
|---|---|---|
| Turns in a session | 12 | `CONSULTANT_CAP_TURNS` |
| Tool calls in a turn | 5 | `CONSULTANT_CAP_TOOL_CALLS` |
| Deep audits in a session | 1 | `CONSULTANT_CAP_DEEP_AUDITS` |
| Tokens in a session (provider total, cache included) | 150,000 | `CONSULTANT_CAP_TOKENS` |
| Output tokens in one model call | 1,024 | `CONSULTANT_CAP_OUTPUT_TOKENS` |
| Idle close | 30 minutes | fixed |
| Maximum lifetime | 2 hours | `CONSULTANT_CAP_LIFETIME_SECONDS` |

## Run it locally

The worker needs a Temporal server and a Claude key. With a required variable missing, it starts nothing and names what is missing.

1. Start a dev server: `temporal server start-dev --port 7300 --ui-port 8300`.
2. Start the worker with `TEMPORAL_ADDRESS=localhost:7300`, `TEMPORAL_NAMESPACE=default` and `ANTHROPIC_API_KEY` set: `npm start -w @mattpyle/consultant`.
3. Hold a conversation: `npm run converse -w @mattpyle/consultant -- --id demo-1 "Can you check my site?" "What should I fix first?"`. A real audit spends a slot of the public rate limit.

## Tests

`npm test -w @mattpyle/consultant` runs the agent on a local Temporal dev server with a scripted model and a stub site. It makes no model call and no site call. `tests/replay.test.ts` replays recorded sessions against the current workflow code.

## Harness compatibility

`src/sdk-compat.ts` works around one import in harness 0.5.0 that fails on Temporal SDK 1.25.0. The start script, the test script and the Dockerfile load it with `--import`. Delete it when a harness release fixes the import.
