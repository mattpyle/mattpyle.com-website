# CLAUDE.md: repo context for mattpyle.com

Context for agents working on this repo. `public/agents.md` is the site-facing brief for agents visiting mattpyle.com, a different thing.

## What this project is

mattpyle.com is a personal site and a testbed for emerging web standards (WebMCP, llms.txt, agents.md, MCP, A2A, agentic-browsing audits). The thesis: AI agents are a first-class user of the web. A change succeeds when it produces a working experiment or a learning. Traffic is a bonus on a low-traffic site.

## Rules

- No prerendered page imports from the Steward workspace. An on-demand route that does says why in its docblock, and a third exports entry needs its own argument and a packaging test.
- The CSP lives in `vercel.json` and `astro.config.mjs` together. `default-src` belongs only in the Astro policy; the reason is the comment in `astro.config.mjs`.
- A new private path goes into `.gitignore` and the `private-paths` job of `.github/workflows/security-scan.yml` in one change.
- PR bodies and commit messages are public and short: what changed, why in the code's own terms, the check evidence. No references to private files, no process narrative.
- A session that needs to build another commit gets its own git worktree with its own `npm ci`. Never junction or symlink `node_modules` from one checkout into another, and never `git worktree remove --force` a tree that holds one: the removal follows the link and deletes the other checkout's files, gitignored ones included.
- Temporal code: use the Temporal skills and the temporal-docs MCP. `agents/steward/CLAUDE.md` holds Steward's own determinism rules; where it disagrees with the docs, say so and check which is current.

## Repo map

| Path | Purpose |
|---|---|
| `src/content/writing/`, `src/content/builds/`, `src/content/changelog/` | Posts, builds and public changelog entries. Frontmatter is Zod-enforced in `src/content.config.ts`. |
| `src/data/scorecard-runs.json` | Live conformance data written by Steward scorecard runs. |
| `agents/steward/` | Steward, the editorial agent and audit runner. Read `agents/steward/CLAUDE.md` and `README.md` before changing it. |
| `agents/benchmark/` | The agent-task benchmark rig, uv-managed Python. Read its README first. |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server. Iterate layout here; fonts, images and CSS inlining differ from prod, layout does not. |
| `SHOW_DRAFTS=true npm run build`, then `npm run serve` | Production build and a server that renders `/scorecard` on demand. A static server 404s it. |
| `npm run new-post -- "Title"` | Scaffold a draft with correct frontmatter. |
| `npm run a11y` | Playwright suite for the manual WCAG checks. Advisory. Regenerate one golden with `--update-snapshots --grep <template>`, never `--update-snapshots=all`. |
| `npm run sweep:retro` | Reports modern colour tokens or fonts leaking into the retro appearance. Advisory. |
| `npm run validate:html`, `npm run validate:llms-txt`, `npm run spellcheck` | Advisory validators. Add jargon with `npm run steward -w @mattpyle/steward -- dict-add <word>`. |
| `steward up` | Local Temporal dev server and worker. |

CI runs the build, axe, the a11y guard and the validators on every PR. Vercel builds a preview per PR, behind Vercel Authentication: read it through the Vercel connector, not a plain fetch.

## Content

- `draft: true` keeps a post out of every index, feed and generated file in every environment. Set `updated:` on substantive edits.
- Images go in `src/assets/` with relative references. `public/` images get no processing and cause layout shift.
- Data goes in markdown tables, not screenshots; agents cannot read numbers out of a PNG.
- Prose styling is the `.prose` block in `src/styles/global.css`, shared by writing and changelog. Body headings start at `h2`.
- House style for pages: lead with the answer, one concept per section, tables and lists over long paragraphs.

## Stack

Astro 7, TypeScript, content collections, Node 24. No framework components or client-side state unless an experiment needs them. Vercel hosts; merging to `master` deploys. `middleware.ts` and `vercel.json` handle markdown content negotiation at the edge; keep their registrations in sync. GitHub: work on a branch and open a PR; the repository owner merges.
