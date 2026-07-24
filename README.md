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
(`Accept: text/markdown`). A handful of pages also register read-only [WebMCP](https://github.com/webmachinelearning/webmcp)
tools — genuinely experimental, and documented as such in `agents.md`.

**A curated [`/changelog`](https://www.mattpyle.com/changelog).** A public, edited-down log of what
shipped on the site — not raw commit history, not an engineering log.

**Steward** (`agents/steward/`) — an editorial agent built on [Temporal](https://temporal.io)
workflows that reviews a draft (spelling, prose linting, an LLM editorial pass, a real build+audit),
waits — durably, for as long as it takes — for a human `approve`/`reject`, then publishes and
verifies its own work against the live site. It's a sidecar: delete the directory and the site
builds and deploys exactly the same. See `agents/steward/README.md` for how it works.

## Local development

Requires Node 22+.

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
| `npm run a11y` | Runs `axe` against a running build. |
| `npm run spellcheck` | `cspell` over all content markdown, including frontmatter. Advisory — doesn't block builds. |
| `npm run test` | Node's built-in test runner over `tests/*.test.mjs`. |
| `npm run validate:sitemap` | Checks the generated sitemap against the content collections. |

`npm run build` also runs a few guard scripts after `astro build`: one asserts no draft content
leaked into the output, one validates the sitemap, and one checks article action wiring.
