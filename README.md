# mattpyle.com

The source for [mattpyle.com](https://www.mattpyle.com) — a personal site that doubles as a live
testbed for emerging web standards: agentic browsing, `llms.txt`, `agents.md`, WebMCP, and whatever
comes next. It's a mix of a bio, a blog ("Writing"), and a portfolio of small side projects
("Builds"), with no product to sell and no stakeholders to answer to.

The premise: AI agents are becoming a first-class consumer of the web, and you can't have a
credible opinion about that from a slide deck. This site is where that opinion gets tested against
a real, deployed target — including publishing the results when an experiment turns out to be a
dead end.

## Stack

- **[Astro 7](https://astro.build)**, static output, deployed on [Vercel](https://vercel.com).
- Content lives in Astro content collections — `src/content/writing/`, `src/content/builds/`,
  `src/content/changelog/` — validated against a Zod schema (`src/content.config.ts`). No CMS.
- No framework components, no client-side state, no backend. Plain HTML/CSS plus a handful of
  build-time scripts.

## Notable parts

**A public scorecard.** [`/scorecard`](https://www.mattpyle.com/scorecard) publishes this site's
own accessibility (axe), performance (Lighthouse), SEO, and agentic-browsing audit results —
including the runs that didn't move anything. It's meant to be a reproducible, comparable
conformance check, not a highlight reel.

**Agent-facing surfaces.** Alongside the usual `robots.txt` and XML sitemap, the site ships
[`agents.md`](https://www.mattpyle.com/agents.md) (a plain-language brief for AI agents and
assistants), [`llms.txt` / `llms-full.txt`](https://www.mattpyle.com/llms.txt) (a machine-readable
index and full-text dump generated at build time from the same content that backs the HTML), and
a `.md` variant of every article and changelog entry served via content negotiation
(`Accept: text/markdown`). The site also registers six [WebMCP](https://github.com/webmachinelearning/webmcp)
tools behind Chrome's origin trial: four that read the site and two that write, including one that
signs the retro guest book with a visible agent-provenance badge. They are documented with runnable
examples at [`/webmcp`](https://www.mattpyle.com/webmcp), and remain genuinely experimental.

**An A2A participant.** The site publishes an Agent Card at
[`/.well-known/agent-card.json`](https://www.mattpyle.com/.well-known/agent-card.json) and answers
real A2A 1.0 `SendMessage` calls at `/a2a`, in the retro webmaster's voice, from a digest compiled
at build time. Calls arriving with the 0.x `message/send` spelling are answered in the 0.x response
shape, so legacy clients can read the reply. Delete the card and the route, and the rest of the
built site is byte-identical.

**A curated [`/changelog`](https://www.mattpyle.com/changelog).** A public, edited-down log of what
shipped on the site — not raw commit history, not an engineering log.

**Steward** (`agents/steward/`) — an editorial agent built on [Temporal](https://temporal.io)
workflows that reviews a draft (spelling, prose linting, an LLM editorial pass, a real build+audit),
waits — durably, for as long as it takes — for a human `approve`/`reject`, then publishes and
verifies its own work against the live site. It's a sidecar: delete the directory and the site
builds and deploys exactly the same. See `agents/steward/README.md` for how it works.

## Local development

Requires Node 24+.

```bash
npm install
npm run dev      # http://localhost:4321, with hot reload
npm run build    # production build to ./dist/
```

> [!NOTE]
> `npm run preview` (plain `astro preview`) doesn't work with the Vercel adapter in this
> configuration. To check a production build locally, serve the output directly instead:
> `npm run build && npx serve dist/client`.

Other scripts:

| Command | Purpose |
| --- | --- |
| `npm run a11y` | Builds, serves `dist/client`, and runs the Playwright accessibility suite in `tests/a11y/`: keyboard order, focus visibility, ClientRouter focus, 320px reflow, reduced motion, the retro-mode checks, and a committed aria-tree golden per template. A tagged axe subset gates PRs in CI; the rest is advisory and stays out of the `build` chain. |
| `npm run a11y:run` | The same suite against whatever is already in `dist/client`. The fast loop. |
| `npm run a11y:axe` | Runs `axe` against a running build. |
| `npm run spellcheck` | `cspell` over all content markdown, including frontmatter. Advisory — doesn't block builds. |
| `npm run test` | Node's built-in test runner over `tests/*.test.mjs`. |
| `npm run validate:sitemap` | Checks the generated sitemap against the content collections. |

The a11y suite needs a browser binary once per machine: `npx playwright install chromium`.

`npm run build` also runs five guard scripts after `astro build`: no draft content in the output, a
valid sitemap, article action wiring, CSP hashes, and a conformant A2A Agent Card.

### Previewing drafts

Content with `draft: true` stays out of every index, feed, sitemap, and `.md` variant. The dev
server renders a draft at its direct URL (for example `/changelog/<slug>`); index pages never list
it, so navigate straight to the entry.

For a faithful pre-publish check, build with drafts enabled and serve the output:

```bash
# bash
SHOW_DRAFTS=true npm run build && npx serve dist/client
```

```powershell
# PowerShell
$env:SHOW_DRAFTS = "true"; npm run build; Remove-Item Env:\SHOW_DRAFTS
npx serve dist/client
```

A draft's generated share image is deliberately not built, so its OG meta points at a missing file
until publish. Expected, not a bug.
