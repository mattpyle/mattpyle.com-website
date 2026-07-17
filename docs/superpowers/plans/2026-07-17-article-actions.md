# Article Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the article’s basic Markdown link with a responsive, accessible utility strip for viewing Markdown, copying Markdown, and opening ChatGPT or Claude with the article’s canonical URL.

**Architecture:** A dependency-free URL helper owns the undocumented provider query syntax. A focused Astro component owns the semantic controls, inline brand icons, responsive styling, copy lifecycle, and status feedback; the writing page supplies canonical and Markdown URLs. A build validator checks the production-rendered action contract so future edits cannot silently remove its accessibility or handoff attributes.

**Tech Stack:** Astro 7, JavaScript ES modules, Astro component scripts, Node 22 test runner, CSS, axe-core CLI, Lighthouse 13.4.0.

## Global Constraints

- Keep the existing static Astro architecture; add no runtime dependency, third-party script, backend, client framework, or article-body duplication.
- Reuse `/writing/<slug>.md` as the only Markdown source.
- Use the exact prompt: `Read from <canonical article URL> so I can ask questions about its contents`.
- Use ChatGPT `https://chatgpt.com/?hint=search&q=<encoded prompt>` and Claude `https://claude.ai/new?q=<encoded prompt>` as experimental, undocumented handoffs.
- Keep View and both Ask links functional without JavaScript; Copy is server-rendered disabled and enabled only after script initialization.
- Do not change canonical metadata, BlogPosting JSON-LD, breadcrumbs, Open Graph, sitemap, RSS, `llms.txt`, `agents.md`, draft behavior, or the Markdown alternate link.
- Render no tooltip. All controls keep visible text labels.
- All four controls must share one alignment primitive: `inline-flex`, centered axes, `min-height: 40px`, identical padding/line-height, and a fixed `14px × 14px` icon box.
- At widths above 600px use a wrapping row; at 600px and below use a two-column equal-width grid that fits at 320px and 200% zoom without horizontal overflow.
- Use pointer/hover feedback only as enhancement; preserve visible keyboard focus, natural tab order, native roles, and polite visible copy status.
- The local production axe result for the representative article must remain zero violations.
- Treat provider prefilling as a time-bound observation, not an official contract, ranking claim, or scoreboard metric.

---

## File map

- Create `src/lib/article-actions.mjs`: construct the shared prompt and provider URLs.
- Create `tests/article-actions.test.mjs`: unit-test exact prompt text, provider parameters, and URL encoding.
- Create `src/components/ArticleActions.astro`: render controls, inline icons, copy script, status, responsive CSS, hover, and focus states.
- Modify `src/pages/writing/[slug].astro`: replace the old link with `ArticleActions` and remove obsolete `.markdown-link` CSS.
- Create `scripts/validate-article-actions.mjs`: assert the contract in the production-rendered representative article.
- Modify `package.json`: run the article-action validator after the existing production-build guards.
- Modify `src/pages/writing/[slug].md.ts`: correct the stale comment that still names the abandoned `vercel.json` rewrite.
- Modify ignored local project docs `changelog.md` and, if the provider check produces a useful observation, `learnings.md`; do not force-add either file to Git.

---

### Task 1: Isolate and test provider handoff URLs

**Files:**
- Create: `tests/article-actions.test.mjs`
- Create: `src/lib/article-actions.mjs`

**Interfaces:**
- Consumes: a canonical article URL string such as `https://www.mattpyle.com/writing/i-turned-on-a-screen-reader/`.
- Produces: `articlePrompt(canonicalUrl): string`, `chatGptUrl(canonicalUrl): string`, and `claudeUrl(canonicalUrl): string`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/article-actions.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { articlePrompt, chatGptUrl, claudeUrl } from '../src/lib/article-actions.mjs';

const canonicalUrl = 'https://www.mattpyle.com/writing/i-turned-on-a-screen-reader/';
const expectedPrompt = `Read from ${canonicalUrl} so I can ask questions about its contents`;

test('articlePrompt uses the approved sentence and canonical URL', () => {
  assert.equal(articlePrompt(canonicalUrl), expectedPrompt);
});

test('chatGptUrl uses the search hint and one encoded prompt', () => {
  const url = new URL(chatGptUrl(canonicalUrl));

  assert.equal(url.origin, 'https://chatgpt.com');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('hint'), 'search');
  assert.equal(url.searchParams.get('q'), expectedPrompt);
  assert.deepEqual([...url.searchParams.keys()], ['hint', 'q']);
});

test('claudeUrl opens a new chat with one encoded prompt', () => {
  const url = new URL(claudeUrl(canonicalUrl));

  assert.equal(url.origin, 'https://claude.ai');
  assert.equal(url.pathname, '/new');
  assert.equal(url.searchParams.get('q'), expectedPrompt);
  assert.deepEqual([...url.searchParams.keys()], ['q']);
});

test('provider URLs round-trip canonical URL special characters', () => {
  const specialCanonicalUrl = 'https://www.mattpyle.com/writing/agents-and-a11y/?edition=one&source=site';
  const specialPrompt = articlePrompt(specialCanonicalUrl);

  assert.equal(new URL(chatGptUrl(specialCanonicalUrl)).searchParams.get('q'), specialPrompt);
  assert.equal(new URL(claudeUrl(specialCanonicalUrl)).searchParams.get('q'), specialPrompt);
});
```

- [ ] **Step 2: Run the unit test to verify it fails for the missing module**

Run:

```powershell
node --test tests/article-actions.test.mjs
```

Expected: exit code 1 with `ERR_MODULE_NOT_FOUND` for `src/lib/article-actions.mjs`.

- [ ] **Step 3: Implement the minimal URL helper**

Create `src/lib/article-actions.mjs`:

```js
/**
 * @param {string} canonicalUrl
 * @returns {string}
 */
export function articlePrompt(canonicalUrl) {
  return `Read from ${canonicalUrl} so I can ask questions about its contents`;
}

/**
 * @param {string} canonicalUrl
 * @returns {string}
 */
export function chatGptUrl(canonicalUrl) {
  const url = new URL('https://chatgpt.com/');
  url.searchParams.set('hint', 'search');
  url.searchParams.set('q', articlePrompt(canonicalUrl));
  return url.toString();
}

/**
 * @param {string} canonicalUrl
 * @returns {string}
 */
export function claudeUrl(canonicalUrl) {
  const url = new URL('https://claude.ai/new');
  url.searchParams.set('q', articlePrompt(canonicalUrl));
  return url.toString();
}
```

- [ ] **Step 4: Run the focused and full unit suites**

Run:

```powershell
node --test tests/article-actions.test.mjs
npm test
```

Expected: the four new tests pass; the full Node test suite exits 0 with no failures.

- [ ] **Step 5: Commit the helper and unit tests**

```powershell
git add -- tests/article-actions.test.mjs src/lib/article-actions.mjs
git commit -m "test: define article assistant handoffs"
```

---

### Task 2: Build and integrate the accessible article utility strip

**Files:**
- Create: `src/components/ArticleActions.astro`
- Create: `scripts/validate-article-actions.mjs`
- Modify: `src/pages/writing/[slug].astro:2-4,29-30,66-70,168-177`
- Modify: `src/pages/writing/[slug].md.ts:16-20`
- Modify: `package.json:9`

**Interfaces:**
- Consumes: `chatGptUrl(canonicalUrl)` and `claudeUrl(canonicalUrl)` from Task 1; component props `canonicalUrl: string` and `markdownUrl: string`.
- Produces: one `<section aria-labelledby="article-actions-title">`, four `.article-action` controls, and `scripts/validate-article-actions.mjs`, which exits nonzero when the rendered contract regresses.

- [ ] **Step 1: Add the failing production-markup validator**

Create `scripts/validate-article-actions.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatGptUrl, claudeUrl } from '../src/lib/article-actions.mjs';

const slug = 'i-turned-on-a-screen-reader';
const canonicalUrl = `https://www.mattpyle.com/writing/${slug}/`;
const markdownUrl = `/writing/${slug}.md`;
const articlePath = new URL(`../dist/client/writing/${slug}/index.html`, import.meta.url);
const html = readFileSync(articlePath, 'utf8');
const htmlAttribute = (value) => value.replaceAll('&', '&amp;');

assert.match(html, /<section[^>]*aria-labelledby="article-actions-title"/);
assert.match(html, /<h2[^>]*id="article-actions-title"[^>]*>Use this article<\/h2>/);
assert.match(html, new RegExp(`href="${markdownUrl.replace('.', '\\.')}">`));

for (const label of ['View markdown', 'Copy markdown', 'Ask ChatGPT', 'Ask Claude']) {
  assert.ok(html.includes(label), `expected rendered article action label: ${label}`);
}

assert.ok(html.includes(`href="${htmlAttribute(chatGptUrl(canonicalUrl))}"`), 'expected ChatGPT handoff URL');
assert.ok(html.includes(`href="${htmlAttribute(claudeUrl(canonicalUrl))}"`), 'expected Claude handoff URL');
assert.equal((html.match(/target="_blank"/g) ?? []).length, 2, 'expected exactly two new-tab links');
assert.equal((html.match(/rel="noreferrer noopener"/g) ?? []).length, 2, 'expected safe rel on both new-tab links');
assert.match(html, /<button[^>]*class="article-action"[^>]*disabled[^>]*data-copy-markdown/);
assert.match(html, /id="article-actions-status"[^>]*role="status"[^>]*aria-live="polite"/);

console.log('validate-article-actions: rendered action contract is valid.');
```

Change the `build` script in `package.json` to:

```json
"build": "astro build && node scripts/assert-no-drafts.mjs && node scripts/validate-sitemap.mjs && node scripts/validate-article-actions.mjs"
```

- [ ] **Step 2: Run the production build to verify the validator fails against the old UI**

Run:

```powershell
npm run build
```

Expected: Astro, draft, and sitemap steps pass; `validate-article-actions.mjs` exits 1 because the rendered article has no labeled action section.

- [ ] **Step 3: Implement the component markup and provider handoffs**

Create `src/components/ArticleActions.astro` with this frontmatter and markup. Use the ChatGPT and Claude SVG paths shown here verbatim; do not replace them with letters or generic chat bubbles.

```astro
---
import { chatGptUrl, claudeUrl } from '../lib/article-actions.mjs';

interface Props {
  canonicalUrl: string;
  markdownUrl: string;
}

const { canonicalUrl, markdownUrl } = Astro.props;
const chatGptHref = chatGptUrl(canonicalUrl);
const claudeHref = claudeUrl(canonicalUrl);
---

<section class="article-actions" aria-labelledby="article-actions-title">
  <h2 id="article-actions-title">Use this article</h2>

  <div class="article-actions-list">
    <a class="article-action" href={markdownUrl}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false">
        <path d="M6 2h9l3 3v17H6z"></path>
        <path d="M9 10h6M9 14h6"></path>
      </svg>
      <span>View markdown</span>
    </a>

    <button
      class="article-action"
      type="button"
      disabled
      data-copy-markdown
      data-markdown-url={markdownUrl}
      aria-describedby="article-actions-status"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false">
        <rect x="8" y="8" width="11" height="11"></rect>
        <path d="M5 16H3V3h13v2"></path>
      </svg>
      <span>Copy markdown</span>
    </button>

    <a class="article-action" href={chatGptHref} target="_blank" rel="noreferrer noopener">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M20.5647 10.1815C21.0185 8.8202 20.8627 7.3302 20.138 6.09079C19.0476 4.19442 16.8532 3.21915 14.713 3.67292C13.7581 2.60283 12.39 1.99328 10.9542 2.00006C8.76659 2.00006 6.82281 3.40879 6.14554 5.48801C4.73681 5.77924 3.52449 6.6597 2.81335 7.90588C1.71617 9.80225 1.96676 12.1863 3.43644 13.8117C2.98267 15.173 3.13844 16.663 3.86312 17.8957C4.95354 19.7988 7.1479 20.7741 9.29486 20.3203C10.243 21.3904 11.6111 22.0067 13.047 21.9999C15.2345 21.9999 17.1783 20.5912 17.8556 18.512C19.2643 18.2208 20.4766 17.3403 21.181 16.0941C22.285 14.1978 22.0344 11.8138 20.5647 10.1883V10.1815ZM19.007 6.74774C19.4404 7.50629 19.603 8.39352 19.454 9.25366C19.4269 9.23334 19.3727 9.20625 19.3388 9.18593L15.3565 6.8832C15.1533 6.76806 14.9027 6.76806 14.6995 6.8832L10.0331 9.57875V7.60111L13.8868 5.37288C15.6815 4.33665 17.9707 4.95297 19.007 6.74774ZM10.0331 10.8588L11.9972 9.72097L13.9613 10.8588V13.1277L11.9972 14.2655L10.0331 13.1277V10.8588ZM10.9474 3.30719C11.8279 3.30719 12.6745 3.61197 13.3517 4.1741C13.3246 4.18765 13.2705 4.22151 13.2298 4.24183L9.24745 6.53779C9.04427 6.65293 8.92236 6.86965 8.92236 7.1067V12.4978L7.20886 11.509V7.05252C7.20886 4.98006 8.88172 3.30719 10.9542 3.30042L10.9474 3.30719ZM3.95117 8.56284C4.3914 7.80429 5.07544 7.22184 5.90172 6.91706V11.6512C5.90172 11.8883 6.02363 12.0982 6.22681 12.2201L10.8865 14.9089L9.16618 15.9045L5.31926 13.683C3.53126 12.6468 2.91494 10.3576 3.95117 8.56284ZM5.00094 17.2523C4.56072 16.5005 4.40494 15.6065 4.55394 14.7463C4.58103 14.7667 4.63522 14.7938 4.66908 14.8141L8.65145 17.1168C8.85463 17.2319 9.10522 17.2319 9.3084 17.1168L13.968 14.4213V16.3989L10.1144 18.6204C8.31958 19.6498 6.0304 19.0403 4.99417 17.2523H5.00094ZM13.0537 20.6928C12.18 20.6928 11.3267 20.388 10.6562 19.8259C10.6833 19.8124 10.7442 19.7785 10.7781 19.7582L14.7605 17.4622C14.9636 17.3471 15.0923 17.1303 15.0855 16.8933V11.509L16.799 12.4978V16.9475C16.799 19.0199 15.1194 20.6996 13.0537 20.6996V20.6928ZM20.0567 15.4372C19.6165 16.1957 18.9257 16.7782 18.1062 17.0762V12.342C18.1062 12.105 17.9843 11.8883 17.7811 11.7731L13.1147 9.07756L14.8282 8.08875L18.6819 10.3102C20.4766 11.3464 21.0862 13.6356 20.05 15.4304L20.0567 15.4372Z"></path>
      </svg>
      <span>Ask ChatGPT</span>
      <span class="external-arrow" aria-hidden="true">↗</span>
      <span class="sr-only"> (opens in a new tab)</span>
    </a>

    <a class="article-action" href={claudeHref} target="_blank" rel="noreferrer noopener">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M5.92381 15.2988L9.85798 13.0912L9.92381 12.8988L9.85798 12.7924H9.66558L9.00735 12.7519L6.75925 12.6912L4.80988 12.6102L2.92127 12.5089L2.44533 12.4076L1.99976 11.8203L2.04533 11.5266L2.44533 11.2583L3.01748 11.3089L4.2833 11.395L6.18203 11.5266L7.55925 11.6076L9.59976 11.8203H9.92381L9.96938 11.6886L9.85798 11.6076L9.77191 11.5266L7.80735 10.195L5.68077 8.78737L4.56684 7.97724L3.96431 7.56711L3.66052 7.1823L3.52887 6.3418L4.07571 5.73927L4.80988 5.7899L4.99722 5.84053L5.74153 6.41268L7.3314 7.64306L9.40735 9.17218L9.71115 9.42534L9.83267 9.33927L9.84786 9.27851L9.71115 9.05066L8.58203 7.01015L7.37697 4.9342L6.84026 4.07344L6.69849 3.55699C6.64786 3.34433 6.61241 3.16712 6.61241 2.94939L7.2352 2.10382L7.5795 1.99243L8.40988 2.10382L8.75925 2.40762L9.27571 3.58737L10.1111 5.4456L11.4074 7.97218L11.7871 8.72154L11.9896 9.41522L12.0656 9.62787H12.1972V9.50635L12.3036 8.08357L12.501 6.33673L12.6934 4.08863L12.7592 3.45572L13.0732 2.69623L13.696 2.2861L14.182 2.51901L14.582 3.09117L14.5263 3.46079L14.2884 5.00509L13.8225 7.42534L13.5187 9.0456H13.696L13.8985 8.84306L14.7187 7.75446L16.096 6.03294L16.7036 5.34939L17.4124 4.59496L17.8681 4.23547H18.7289L19.3618 5.17724L19.0782 6.14939L18.1922 7.27344L17.458 8.22534L16.4048 9.64306L15.7466 10.7772L15.8074 10.8684L15.9643 10.8532L18.3441 10.3469L19.6301 10.114L21.1643 9.85066L21.858 10.1747L21.9339 10.5038L21.6605 11.1772L20.02 11.5823L18.096 11.9671L15.2301 12.6456L15.1947 12.6709L15.2352 12.7215L16.5263 12.8431L17.0782 12.8734H18.4301L20.9466 13.0608L21.6048 13.4962L21.9998 14.0279L21.9339 14.4329L20.9213 14.9494L19.5542 14.6253L16.3643 13.8658L15.2706 13.5924H15.1187V13.6836L16.0301 14.5747L17.701 16.0836L19.7922 18.0279L19.8985 18.5089L19.6301 18.8886L19.3466 18.8481L17.5086 17.4658L16.7998 16.8431L15.1947 15.4912H15.0884V15.6329L15.458 16.1747L17.4124 19.1114L17.5137 20.0127L17.3719 20.3064L16.8656 20.4836L16.3086 20.3823L15.1643 18.7772L13.9846 16.9696L13.0327 15.3494L12.9162 15.4152L12.3542 21.4658L12.0909 21.7747L11.4833 22.0076L10.977 21.6228L10.7086 21L10.977 19.7696L11.301 18.1646L11.5643 16.8886L11.8023 15.3038L11.9441 14.7772L11.9339 14.7418L11.8175 14.757L10.6225 16.3975L8.80482 18.8532L7.36684 20.3924L7.02254 20.5291L6.42507 20.2203L6.48077 19.6684L6.81495 19.1772L8.80482 16.6456L10.0048 15.076L10.7795 14.1696L10.7744 14.038H10.7289L5.44279 17.4709L4.50102 17.5924L4.09596 17.2127L4.14659 16.5899L4.339 16.3874L5.92887 15.2937L5.92381 15.2988Z"></path>
      </svg>
      <span>Ask Claude</span>
      <span class="external-arrow" aria-hidden="true">↗</span>
      <span class="sr-only"> (opens in a new tab)</span>
    </a>
  </div>

  <p id="article-actions-status" class="article-actions-status" role="status" aria-live="polite"></p>
</section>
```

- [ ] **Step 4: Add the copy lifecycle script**

Append this processed Astro script inside `src/components/ArticleActions.astro`, after the markup and before the component style:

```astro
<script>
  function initializeArticleActions() {
    document.querySelectorAll<HTMLButtonElement>('[data-copy-markdown]').forEach(button => {
      if (button.dataset.copyReady === 'true') return;

      const statusId = button.getAttribute('aria-describedby');
      const status = statusId ? document.getElementById(statusId) : null;
      const markdownUrl = button.dataset.markdownUrl;
      if (!status || !markdownUrl) return;

      button.dataset.copyReady = 'true';
      button.disabled = false;

      button.addEventListener('click', async () => {
        status.textContent = '';

        try {
          const response = await fetch(markdownUrl, {
            headers: { Accept: 'text/markdown' },
          });
          const contentType = response.headers.get('content-type') ?? '';

          if (!response.ok || !contentType.toLowerCase().startsWith('text/markdown')) {
            throw new Error('Markdown endpoint returned an unexpected response.');
          }
          if (!navigator.clipboard?.writeText) {
            throw new Error('Clipboard API is unavailable.');
          }

          const markdown = await response.text();
          await navigator.clipboard.writeText(markdown);
          status.textContent = 'Markdown copied.';
        } catch {
          status.textContent = 'Couldn’t copy Markdown. Open View markdown and copy it manually.';
        }
      });
    });
  }

  initializeArticleActions();
  document.addEventListener('astro:page-load', initializeArticleActions);
</script>
```

- [ ] **Step 5: Add the shared alignment, responsive, hover, and focus CSS**

Append this scoped style to `src/components/ArticleActions.astro`:

```astro
<style>
  .article-actions {
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--color-border);
  }

  h2 {
    margin: 0 0 9px;
    color: var(--color-label);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 400;
    letter-spacing: .1em;
    line-height: 1.3;
    text-transform: uppercase;
  }

  .article-actions-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .article-action {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: 2px;
    background: transparent;
    color: var(--color-accent);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 400;
    letter-spacing: .02em;
    line-height: 1.2;
    text-align: center;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition: color .15s ease, background-color .15s ease, border-color .15s ease;
  }

  .article-action svg {
    display: block;
    flex: 0 0 14px;
    width: 14px;
    height: 14px;
  }

  .external-arrow {
    color: var(--color-muted);
  }

  .article-action:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .article-action:disabled {
    opacity: .55;
    cursor: not-allowed;
  }

  .article-actions-status {
    min-height: 1.4em;
    margin: 8px 0 0;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.4;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (hover: hover) and (pointer: fine) {
    .article-action:not(:disabled):hover {
      color: var(--color-accent-hover);
      background: var(--color-accent-tint);
      border-color: var(--color-accent);
    }
  }

  @media (max-width: 600px) {
    .article-actions-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .article-action {
      width: 100%;
      min-width: 0;
      padding-inline: 8px;
    }

    .article-actions-status {
      min-height: 2.8em;
    }
  }
</style>
```

- [ ] **Step 6: Integrate the component and remove the obsolete link styles**

In `src/pages/writing/[slug].astro`:

1. Add the import after `Layout`:

```astro
import ArticleActions from '../../components/ArticleActions.astro';
```

2. Define URLs after the article data destructure:

```astro
const markdownUrl = `/writing/${article.id}.md`;
const canonicalUrl = new URL(`/writing/${article.id}/`, Astro.site).toString();
```

3. Reuse `markdownUrl` in the Layout prop:

```astro
markdownAlternate={markdownUrl}
```

4. Replace the old `<a class="markdown-link">` with:

```astro
<ArticleActions canonicalUrl={canonicalUrl} markdownUrl={markdownUrl} />
```

5. Delete the `.markdown-link` and `.markdown-link:hover` rules at the former lines 168–177.

In `src/pages/writing/[slug].md.ts`, replace the stale rewrite comment above the collection lookup with:

```ts
// middleware.ts proxies negotiated Markdown requests to this explicit endpoint.
// The direct /writing/<slug>.md URL also powers View and Copy in ArticleActions.
```

- [ ] **Step 7: Run the build validator and unit suite**

Run:

```powershell
npm run build
npm test
```

Expected: `validate-article-actions: rendered action contract is valid.`, all existing draft/sitemap guards pass, and the full Node suite exits 0.

- [ ] **Step 8: Inspect the production diff before committing**

Run:

```powershell
git diff --check
git diff -- src/components/ArticleActions.astro src/pages/writing/[slug].astro src/pages/writing/[slug].md.ts src/lib/article-actions.mjs tests/article-actions.test.mjs scripts/validate-article-actions.mjs package.json
```

Expected: no whitespace errors; only the approved utility-strip implementation, validator, helper, tests, and comment correction appear.

- [ ] **Step 9: Commit the integrated feature**

```powershell
git add -- package.json scripts/validate-article-actions.mjs src/components/ArticleActions.astro src/pages/writing/[slug].astro src/pages/writing/[slug].md.ts
git commit -m "feat: add article markdown and AI actions"
```

---

### Task 3: Verify the complete interaction and record the experiment

**Files:**
- Modify locally: `changelog.md`
- Modify locally only if a useful provider observation is made: `learnings.md`
- Verify: `dist/client/writing/i-turned-on-a-screen-reader/index.html`

**Interfaces:**
- Consumes: the complete action component and raw-Markdown endpoint from Tasks 1–2.
- Produces: fresh evidence for unit/build correctness, responsive behavior, accessibility, clipboard behavior, provider handoffs, and layout stability.

- [ ] **Step 1: Run fresh automated verification**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected: zero test failures, production build exit 0 including all three validators, and no whitespace errors.

- [ ] **Step 2: Start the local production server and run axe**

Start `dist/client` on port 4321 in a background terminal:

```powershell
npx serve dist/client -l 4321
```

After `http://localhost:4321` responds, run:

```powershell
npm run --silent a11y -- --exit http://localhost:4321/writing/i-turned-on-a-screen-reader/
```

Expected: axe reports `0 violations` and exits 0. Never substitute `npm run dev` for this audit.

- [ ] **Step 3: Inspect responsive and interaction states in a real browser**

At `http://localhost:4321/writing/i-turned-on-a-screen-reader/`, inspect desktop, 600px, and 320px widths plus 200% zoom. Verify all of the following:

- Four controls are present in the approved order.
- Desktop/tablet uses a wrapping row; 600px and 320px use an equal two-column grid.
- Icons and labels are vertically centered and aligned across links and the button.
- No label clips, overlaps, or causes horizontal scrolling.
- Fine-pointer hover changes background, border, and text color and shows a pointer cursor.
- Tab order matches visual order; every control has the visible oxblood focus outline.
- External links expose “opens in a new tab” to the accessibility tree exactly once.
- No tooltip appears or is required.

Expected: every check passes before proceeding.

- [ ] **Step 4: Exercise View and Copy against a server that runs the on-demand endpoint**

Stop the production static server and start Astro dev:

```powershell
npm run dev
```

At `http://localhost:4321/writing/i-turned-on-a-screen-reader/`:

1. Open View markdown and confirm the response is Markdown with attribution frontmatter, not HTML.
2. Return to the article, activate Copy markdown, and confirm the visible status says `Markdown copied.`.
3. Paste into a plain-text field and compare the text byte-for-byte with the `.md` response body.
4. In browser devtools, block `/writing/i-turned-on-a-screen-reader.md`, activate Copy again, and confirm the approved failure message appears while focus remains on the button.

Expected: exact copy on success and the approved recovery message on failure. Do not use dev-server axe or Lighthouse results as conformance evidence.

- [ ] **Step 5: Check the external provider handoffs without promising submission**

Activate each Ask link and inspect the destination URL. Confirm the decoded `q` value is exactly:

```text
Read from https://www.mattpyle.com/writing/i-turned-on-a-screen-reader/ so I can ask questions about its contents
```

For ChatGPT, also confirm `hint=search`; for Claude, confirm path `/new`. Record whether the provider prefills the prompt on 2026-07-17, but do not fail the feature if an undocumented provider drops it.

- [ ] **Step 6: Run the matched local-production Lighthouse layout check**

Restart the production static server, then run Lighthouse 13.4.0:

```powershell
npx --yes lighthouse@13.4.0 http://localhost:4321/writing/i-turned-on-a-screen-reader/ --only-categories=performance,accessibility --output=json --output-path=C:\tmp\article-actions-lighthouse.json --chrome-flags="--headless --no-sandbox"
```

Read `audits.cumulative-layout-shift.numericValue` from `C:\tmp\article-actions-lighthouse.json`.

Expected: CLS is `<= 0.1` and no new accessibility audit fails. Record this as a local production layout check only; do not compare its performance score with the live-network scoreboard baseline.

- [ ] **Step 7: Record the change in the private local changelog**

Prepend this entry below the title and last-updated line in ignored `changelog.md`, changing `_Last updated_` to `2026-07-17`:

```markdown
## 2026-07-17 — Article Markdown and AI handoff actions

slug: `article-markdown-ai-actions`
tags: [writing, accessibility, aeo, ux]
summary: Replaced the basic “View as Markdown” link with a responsive, accessible utility strip for viewing and copying the exact raw-Markdown representation and opening ChatGPT or Claude with the article’s canonical URL.

**Hypothesis.** The four controls can be added without an axe violation, horizontal overflow, or material layout shift while keeping the Markdown endpoint as the single source of truth.

**What shipped.** The article header now contains a labeled “Use this article” section. View remains a normal Markdown link; Copy fetches and verifies the same-origin Markdown response before using the Clipboard API; ChatGPT and Claude receive a short prompt containing only the canonical public URL. The controls share one alignment primitive and become an equal two-column grid at 600px and below. No dependency, third-party script, backend, tooltip, or duplicated article body was added.

**Provider caveat.** OpenAI and Anthropic do not document these inbound prompt URLs. The ChatGPT `hint=search&q=` and Claude `/new?q=` handoffs are explicitly experimental and do not promise automatic submission or even durable prefilling.

**Verification.** The URL-helper unit tests, full Node suite, production build guards, rendered-markup validator, production-render axe audit, keyboard/focus review, 320px/600px/desktop layout checks, 200% zoom check, on-demand View/Copy success and failure paths, and a matched local-production Lighthouse CLS check all passed. Provider prefilling remains a time-bound observation rather than a conformance claim.

Standards affected: none in `scoreboard.md` unless a reproducible existing metric changes. This is a human-facing UX and agent-handoff experiment built on the already-recorded Markdown infrastructure.

---
```

Do not stage or force-add `changelog.md`; repository policy intentionally keeps it private and ignored.

- [ ] **Step 8: Record a provider learning only if the manual check is informative**

If both providers prefill, append this exact entry to ignored `learnings.md`:

```markdown
## 2026-07-17 — “Ask AI” links are conventions, not APIs

ChatGPT’s `hint=search&q=` and Claude’s `/new?q=` links both prefilled the approved article prompt in a manual check on 2026-07-17, but neither provider documents the behavior as a public inbound contract. The useful implementation pattern is therefore isolation and graceful degradation: keep the prompt short, pass only the public canonical URL, generate the URLs in one helper, and preserve View/Copy as deterministic paths. A successful check today is evidence of current behavior, not evidence of stability.
```

If either provider does not prefill, append this exact alternative instead:

```markdown
## 2026-07-17 — “Ask AI” links are conventions, not APIs

At least one of the ChatGPT `hint=search&q=` or Claude `/new?q=` links failed to prefill the approved article prompt in a manual check on 2026-07-17. That confirms the core design constraint: neither provider documents a stable inbound prompt contract. The deterministic product is View/Copy Markdown; the Ask links are a best-effort convenience that must carry only a short public URL prompt and remain isolated behind one easy-to-update helper.
```

Do not stage or force-add `learnings.md`.

- [ ] **Step 9: Request final code review and inspect repository state**

Dispatch one reviewer focused on spec compliance and one reviewer focused on accessibility/responsive behavior. Review every finding against the approved spec, fix confirmed issues with a new failing test where applicable, then rerun Steps 1–6.

Finally run:

```powershell
git status --short
git log -3 --oneline
```

Expected: tracked production changes are committed; only the visual-companion `.superpowers/` directory may remain untracked, and private `changelog.md`/`learnings.md` remain ignored. Report the untracked visual-companion directory rather than staging it.

