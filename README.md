# Astro Starter Kit: Minimal

```sh
npm create astro@latest -- --template minimal
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
├── src/
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |
| `npm run spellcheck`      | Spell check content markdown (see below)         |

## ✍️ Spell check

`npm run spellcheck` runs [cspell](https://cspell.org) over `src/content/**/*.md` — the `writing`,
`changelog`, and `builds` collections.

**It checks source markdown, not the built site.** That is deliberate: posts marked `draft: true` are
stripped from `astro build` output, so checking the build would skip exactly the drafts that most need
proofreading before they are published.

**It checks frontmatter as well as body prose.** cspell reads YAML frontmatter as ordinary text, so
`title`, `description`, `seoTitle`, and `seoDescription` are covered. This matters more than body typos:
`description` flows into `<title>`, Open Graph tags, and the RSS feed, and a published RSS entry gets
cached and redistributed by other people's readers.

| File | Role |
| :--- | :--- |
| `cspell.json` | Config (JSONC — comments allowed) |
| `project-words.txt` | Project dictionary |
| `.github/workflows/spellcheck.yml` | CI on push to `master` and on PRs |

**Adding a word:** one bare word per line in `project-words.txt`. Keep comments on their *own* line —
cspell splits wordlist lines on whitespace, so a trailing comment quietly adds its words to the
dictionary. Add words only for genuine jargon or proper nouns, never to paper over a real typo. Common
tooling terms (`Astro`, `Vercel`, `a11y`, `Lighthouse`) are already in cspell's bundled dictionaries.

**This check is advisory.** It is intentionally not part of `npm run build`. CI will mark a pull request
red on a finding, but it does not block deploys. Code fences are not currently exempt from checking.

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
