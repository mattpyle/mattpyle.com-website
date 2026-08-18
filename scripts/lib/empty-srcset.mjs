/**
 * Remove the empty `srcset=""` Astro emits on content-collection markdown images.
 *
 * `<img srcset="">` is a validity error — the attribute's grammar requires at least one image
 * candidate string — and Astro emits it on every image written as `![alt](…)` inside a content
 * collection entry whose source is too small to produce any responsive variant. The site's one
 * such image is 484px wide, below every breakpoint the local image service uses, so its candidate
 * list comes out empty and is serialised anyway.
 *
 * This is an upstream defect, not a choice the site makes. `updateImageReferencesInHTML` in
 * `astro/dist/content/runtime.js` builds the attribute list as
 * `{ ...attributes, src, srcset: image.srcSet.attribute }`, filters out `null`/`undefined`, and
 * then has an explicit branch that serialises an empty string as `key=""`. The equivalent code on
 * the plain-markdown path (`astro/dist/vite-plugin-markdown/images.js`) guards with
 * `srcSet.values.length > 0` and gets this right; the content-collection path does not. Confirmed
 * present in Astro 7.2.0 (installed) and 7.2.2 (latest) on 2026-08-17.
 *
 * **Delete this when Astro fixes it.** The check that will tell you: `npm run validate:html`
 * passes with the `astro:build:done` hook in `astro.config.mjs` removed.
 *
 * Attribute-level rather than a full HTML parse on purpose. A parse-and-reserialise pass over
 * every built page to delete one always-worthless attribute would risk changing markup this
 * codebase has spent real effort getting exactly right (the CSP `<meta>`, the inline appearance
 * script, the `is:inline` JSON-LD), and `scripts/validate-csp-hashes.mjs` re-hashes those bytes
 * after the fact. The pattern below matches only a literally empty `srcset` attribute on an
 * element, which no template in `src/` writes by hand.
 */

/** A `srcset` attribute whose value is empty, in either quoting style, with its leading space. */
const EMPTY_SRCSET = /\s+srcset=(""|'')/g;

/**
 * @param {string} html
 * @returns {{ html: string, removed: number }} the cleaned HTML and how many attributes went
 */
export function stripEmptySrcset(html) {
  let removed = 0;
  const cleaned = html.replace(EMPTY_SRCSET, () => {
    removed++;
    return '';
  });
  return { html: cleaned, removed };
}
