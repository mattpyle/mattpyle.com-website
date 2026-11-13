# Spike MPW-565: an audit consultant on the TypeScript agent harness

A spike for MPW-224. It is not built, tested or deployed by anything in this repository, and nothing merges it.

It runs a Claude-driven agent on `@temporalio/agent-harness` 0.5.0, through the Strands Agents integration, on a local Temporal dev server.

## Why it is standalone

This folder is not in the root `workspaces` list. It has its own `package.json` and `package-lock.json`, and pins every `@temporalio/*` package at 1.24.0. Steward and the root package pin 1.20.3, and one install must not mix two Temporal SDK versions.

## Files

| File | What it is |
|---|---|
| `agents.ts` | The agent: one `ask` handler, an activity tool `audit_site` and a callback tool `ask_user`. |
| `worker.ts` | The worker. `audit_site` returns a canned, structured result, so only the model call uses the network. |
| `converse.mjs` | A driver that uses a plain `@temporalio/client` and raw Update, Query and stream names. It imports no harness package. |
| `evidence/` | Logs and the workflow history from the runs in the record. |

## Run it

Each command runs from this folder. PowerShell.

1. Install, with no install scripts. None is needed on Windows x64.

   ```powershell
   npm ci --ignore-scripts
   ```

2. Start the spike's own dev server on port 7300.

   ```powershell
   temporal server start-dev --port 7300 --ui-port 8300
   ```

3. Start the worker. The key reaches it only through `op run`.

   ```powershell
   $env:ANTHROPIC_API_KEY = "<1Password secret reference>"; op run -- fnm exec --using 24 node --import tsx worker.ts
   ```

4. Run the four-turn conversation. The first argument names the `node_modules` folder whose `@temporalio/client` the driver uses.

   ```powershell
   fnm exec --using 24 node converse.mjs node_modules conv-1 --start
   ```

Driver flags: `--turns N`, `--from-turn N`, `--stop-at-callback` (exit with the callback parked), `--send-only`, `--resume` (attach to the turn in flight), `--dump`.
