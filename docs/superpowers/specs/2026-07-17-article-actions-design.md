# Article Actions Design

**Date:** 2026-07-17  
**Status:** Approved for implementation  
**Applies to:** Published and locally previewed pages at `/writing/<slug>`

## Purpose

Replace the basic “View as Markdown” text link with a quiet, responsive article utility strip containing four actions:

1. View markdown
2. Copy markdown
3. Ask ChatGPT
4. Ask Claude

The feature makes the existing raw-Markdown representation useful to human readers and provides lightweight, backend-free handoffs to external AI services. It remains progressive enhancement: article reading, raw Markdown, canonical discovery, and external handoffs do not depend on the copy script.

## Pre-change hypothesis

**Tier:** Tier 1 — deterministic lab behavior.

Adding an article utility strip can expose all four actions without introducing an axe violation, horizontal overflow, or material layout shift. At 320px, 600px, and desktop widths, every action will remain readable and operable; View and Copy will use the exact raw-Markdown endpoint; and the two AI actions will contain the canonical article URL in correctly encoded provider handoffs.

Successful provider prefilling is an experimental observation, not a stable contract or an outcome claim. Neither OpenAI nor Anthropic officially documents these inbound prompt URLs.

## Goals

- Make the four actions visible without turning the article header into product-dashboard chrome.
- Reuse `/writing/<slug>.md` as the only Markdown rendering source.
- Keep View and Ask usable without client JavaScript.
- Copy the exact served Markdown only after user interaction.
- Use native links and buttons with clear names, keyboard focus, and status feedback.
- Preserve current canonical, structured-data, sitemap, RSS, draft, and alternate-link behavior.
- Add no runtime dependency, third-party script, backend, or client framework.

## Non-goals

- A first-party chatbot, RAG service, conversation history, or model API integration.
- Sending the full article body in an external query string.
- Guaranteeing that ChatGPT or Claude will prefill or submit a prompt.
- Tooltips, icon-only controls, sticky UI, analytics, or share tracking.
- Changing the raw-Markdown format, content negotiation, canonical URL, or article schema.
- Resolving the existing nonportable relative image path in the raw Markdown. That endpoint behavior predates this feature and should be handled separately.

## Selected visual direction

Use the approved “quiet utility strip” directly beneath the article tags and before the prose. A fine top rule separates utilities from taxonomy. The strip has a small mono label, “Use this article,” followed by four bordered controls.

Provider controls use the ChatGPT and Claude logos supplied in the approved reference. View and Copy use simple document and copy icons. Every icon is decorative because the adjacent visible text supplies the accessible name. Ask controls include a visible `↗` indicator and hidden “opens in a new tab” text.

No tooltip is included. Every action already has a visible, unambiguous label, so a tooltip would duplicate rather than clarify information.

## Component architecture

Create `src/components/ArticleActions.astro` and render it from `src/pages/writing/[slug].astro` in place of the existing `.markdown-link` anchor.

The component accepts:

```ts
interface Props {
  canonicalUrl: string;
  markdownUrl: string;
}
```

The article page supplies:

```ts
canonicalUrl={new URL(`/writing/${article.id}/`, Astro.site).toString()}
markdownUrl={`/writing/${article.id}.md`}
```

Create `src/lib/article-actions.mjs` for the volatile provider URL syntax. It exports:

```js
export function articlePrompt(canonicalUrl) {}
export function chatGptUrl(canonicalUrl) {}
export function claudeUrl(canonicalUrl) {}
```

The helper is dependency-free and uses `URL` plus `searchParams.set()` so encoding is never assembled manually. Keeping the undocumented provider contracts isolated allows future syntax changes without touching the component.

## Provider handoffs

Both providers receive the exact starter prompt:

```text
Read from <canonical article URL> so I can ask questions about its contents
```

The resulting URL shapes are:

```text
https://chatgpt.com/?hint=search&q=<encoded prompt>
https://claude.ai/new?q=<encoded prompt>
```

Both are ordinary anchors with:

```html
target="_blank" rel="noreferrer noopener"
```

The prompt contains only the public canonical URL and fixed instructional copy. It never contains article text, user input, secrets, or personal data. The links do not promise automatic submission. If a provider drops the query, the destination may open as an empty new chat; this is an accepted experimental limitation.

## Copy behavior and states

“Copy markdown” is a native `<button type="button">`. It is server-rendered with `disabled` and enabled only when the component script initializes. If JavaScript is unavailable, the button remains honestly unavailable while View and both Ask links continue to work.

On activation:

1. Fetch `markdownUrl` from the same origin.
2. Require `response.ok`.
3. Require a `Content-Type` beginning with `text/markdown`.
4. Read the response body as text.
5. Call `navigator.clipboard.writeText(markdown)`.
6. Leave keyboard focus on the Copy button.
7. Write “Markdown copied.” into a reserved visible `role="status"` region with polite announcements.

If any step fails, keep focus on the button and announce:

```text
Couldn’t copy Markdown. Open View markdown and copy it manually.
```

The status region reserves enough height for the longest failure message to wrap at 320px, so success and failure text do not move the controls or prose. The Copy button’s visible label stays “Copy markdown”; changing it to “Copied” would alter the row width and create avoidable movement.

The script follows the existing Astro ClientRouter lifecycle pattern: initialize on the current document and again on `astro:page-load`, while marking initialized controls to prevent duplicate handlers.

## Semantic structure

The component renders a `<section aria-labelledby="article-actions-title">` with a visible `<h2 id="article-actions-title">Use this article</h2>`. This preserves the page’s `h1` and gives the utility region an understandable name without misusing a navigation landmark for a mixed link/button group.

Control order is fixed and matches reading and tab order:

1. View markdown — anchor, same tab
2. Copy markdown — button
3. Ask ChatGPT — external anchor, new tab
4. Ask Claude — external anchor, new tab

Logos, action icons, and the external arrow use `aria-hidden="true"`. Each external link includes visually hidden text, “opens in a new tab,” within its accessible name.

## Layout and interaction styling

All four controls share a single `.article-action` style. Links and the button reset browser-specific differences and use:

- `display: inline-flex`
- `align-items: center`
- `justify-content: center`
- identical `min-height: 40px`
- identical horizontal and vertical padding
- identical mono font, font size, and `line-height: 1.2`
- a fixed `14px × 14px` nonshrinking icon box
- one shared gap between icon and label
- `white-space: nowrap`

These shared rules are the acceptance mechanism for vertically centered icons/text and alignment across anchor and button elements.

At widths above 600px, the controls use a flex row with wrapping. At 600px and below, they use a two-column grid with equal-width columns. The existing 20px mobile article gutter remains unchanged. The grid must fit at 320px without text clipping, overlap, or horizontal scrolling, including at 200% browser zoom.

All actions use `cursor: pointer`. Hover styling is limited to devices matching `(hover: hover) and (pointer: fine)` and changes background, border, and text color. The hover state does not encode information. Focus uses a 2px oxblood outline with a 2px offset and remains visible independently of hover. Transitions are limited to short color changes; no spatial animation is added.

## Accessibility requirements

- Native anchors for navigation and native button semantics for Copy.
- Visible text labels; no icon-only control and no tooltip dependency.
- Natural DOM/tab order with no positive `tabindex`.
- A visible, persistent focus indicator for links and the button.
- At least a 40px control height, exceeding WCAG 2.2’s 24px minimum target-size requirement.
- Visible and polite copy feedback; failure includes a concrete recovery path.
- New-tab behavior communicated visually and to assistive technology.
- No information conveyed by color, hover, or provider logo alone.
- No horizontal overflow at 320px or under 200% zoom.
- Zero axe violations on the production-rendered representative article.

## SEO and AEO requirements

- Do not change the HTML canonical, BlogPosting JSON-LD, breadcrumbs, Open Graph metadata, sitemap, RSS, `llms.txt`, `agents.md`, or `<link rel="alternate" type="text/markdown">`.
- The HTML article remains canonical; the `.md` endpoint continues to identify the HTML page as canonical.
- Ask links carry only the canonical HTML URL, not the `.md` URL, so providers receive the public identity of the article and can follow its Markdown alternate if supported.
- The feature makes no ranking, citation, or adoption claim.

## Performance requirements

- No dependency or third-party script.
- Inline SVG paths only; no image or font request.
- No Markdown request until Copy is activated.
- No article content embedded a second time in the HTML.
- Stable control and status-region geometry to avoid CLS.
- The existing strict CSP remains unchanged.

## Testing and verification

### Automated tests

Add `tests/article-actions.test.mjs` before implementation. It must verify:

- `articlePrompt()` returns the exact approved sentence and canonical URL.
- `chatGptUrl()` uses origin `https://chatgpt.com`, `hint=search`, and one correctly decoded `q` value.
- `claudeUrl()` uses origin `https://claude.ai`, path `/new`, and one correctly decoded `q` value.
- Special characters in a canonical URL round-trip through both query strings.
- The production build contains one labeled action section, all four visible labels, correct `.md` href, both external URLs, new-tab attributes, and the disabled Copy button.

### Manual functional checks

- View opens the correct `.md` endpoint and the body is Markdown, not HTML.
- Copy writes byte-for-byte the same body returned by the `.md` endpoint.
- A forced fetch or clipboard failure produces the approved visible/announced message and preserves focus.
- ChatGPT and Claude open in new tabs with the canonical URL in the decoded prompt.
- Record whether each provider prefills the prompt on the test date; treat the result as experimental and time-bound.
- Navigate all four controls with keyboard only and verify focus order and focus visibility.
- Confirm a screen reader announces the section, button/link roles, new-tab disclosure, success, and failure once each.

### Responsive and quality checks

- Inspect at 320px, 600px, and desktop widths.
- Confirm icons and labels are vertically centered and aligned across anchors and the button.
- Confirm the 2 × 2 grid has equal columns and no clipping at 320px and 200% zoom.
- Confirm pointer cursor and hover feedback on a fine-pointer device.
- Run `npm test`.
- Run `npm run build`.
- Serve the local production build and run axe against `/writing/i-turned-on-a-screen-reader`; require zero violations.
- Run a matched local-production Lighthouse layout check for CLS. Do not compare this local result with the live-network scoreboard baseline.
- Exercise the on-demand Markdown and Copy flow against Astro dev or a deployed Vercel preview because `astro preview` cannot serve the on-demand `.md` route.

## Documentation after implementation

Add a dated `changelog.md` entry that records the pre-change hypothesis, selected implementation, verification evidence, and the undocumented status of provider-prefill URLs. Put objective reproducible results in `scoreboard.md` only if an existing conformance metric changes. Put any subjective provider/deep-link learning in `learnings.md`.
