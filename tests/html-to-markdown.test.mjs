import assert from 'node:assert/strict';
import test from 'node:test';
import { extractMain, extractMetadata, pageToMarkdown } from '../scripts/lib/html-to-markdown.mjs';

function page(main, head = '') {
  return `<!doctype html><html><head><title>Page — Matt Pyle</title><meta name="description" content="A page."><link rel="canonical" href="https://www.mattpyle.com/page/">${head}</head><body><a href="#main" class="skip-link">Skip to content</a><nav>Nav</nav><main class="site-main" id="main">${main}</main><footer>Footer</footer></body></html>`;
}

test('extraction takes the main landmark and nothing around it', () => {
  const main = extractMain(page('<h1>Page</h1>'));
  assert.equal(main, '<h1>Page</h1>');

  const markdown = pageToMarkdown(page('<h1>Page</h1><p>Body.</p>'));
  assert.match(markdown, /# Page/);
  assert.equal(markdown.includes('Skip to content'), false);
  assert.equal(markdown.includes('Nav'), false);
  assert.equal(markdown.includes('Footer'), false);
});

test('a page without a main landmark converts to nothing', () => {
  assert.equal(extractMain('<html><body><p>No landmark</p></body></html>'), null);
  assert.equal(pageToMarkdown('<html><body><p>No landmark</p></body></html>'), null);
});

test('tables survive as tables', () => {
  const markdown = pageToMarkdown(
    page(
      '<h1>Tools</h1><table><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody><tr><td><code>limit</code></td><td>integer</td></tr></tbody></table>'
    )
  );
  assert.match(markdown, /\| Name \| Type \|/);
  assert.match(markdown, /\| `limit` \| integer \|/);
});

test('links survive with their root-relative hrefs', () => {
  const markdown = pageToMarkdown(page('<h1>Page</h1><p>See <a href="/writing/">the writing</a>.</p>'));
  assert.match(markdown, /\[the writing\]\(\/writing\/\)/);

  const absolute = pageToMarkdown(page('<h1>Page</h1><p><a href="https://github.com/mattpyle">GitHub</a></p>'));
  assert.match(absolute, /\[GitHub\]\(https:\/\/github\.com\/mattpyle\)/);
});

test('a card-shaped link keeps its destination by moving onto the heading', () => {
  // A project card and a changelog row are each one <a> wrapping block content. Left alone,
  // turndown spreads the label over several lines and no markdown parser reads it back as a
  // link. The class here is arbitrary: the rule matches on the shape, not on a class name.
  const markdown = pageToMarkdown(
    page(
      '<h1>Changelog</h1><a href="/changelog/site-live" class="card"><div><span>02 AUG 2026</span></div><div><h2>Site is live</h2><p>Summary text.</p></div></a>'
    )
  );
  assert.match(markdown, /## \[Site is live\]\(\/changelog\/site-live\)/);
  assert.match(markdown, /Summary text\./);
  assert.match(markdown, /02 AUG 2026/);
});

test('a link with only inline content is left exactly as it was', () => {
  const markdown = pageToMarkdown(
    page('<h1>Home</h1><p><a href="/writing/"><span>All</span> <span>writing</span></a></p>')
  );
  assert.match(markdown, /\[All writing\]\(\/writing\/\)/);
});

test('retro-only furniture is dropped by its marker class, not by page', () => {
  const markdown = pageToMarkdown(
    page('<h1>Home</h1><section class="retro-furniture guestbook-section"><h2>Guest Book</h2><p>Sign it.</p></section><p>Real content.</p>')
  );
  assert.equal(markdown.includes('Guest Book'), false);
  assert.equal(markdown.includes('Sign it.'), false);
  assert.match(markdown, /Real content\./);
});

test('the legacy tree of a two-tree page is dropped, so the page converts once', () => {
  const markdown = pageToMarkdown(
    page(
      '<div class="modern-skin"><h1>About</h1><p>Modern wording.</p></div>' +
        '<div class="retro-skin"><h1>ABOUT</h1><p>Legacy wording.</p></div>'
    )
  );
  assert.match(markdown, /Modern wording\./);
  assert.equal(markdown.includes('Legacy wording.'), false);
  assert.equal(markdown.match(/^#+ /gm).length, 1);
});

test('behaviour, decoration and interactive controls are not content', () => {
  const markdown = pageToMarkdown(
    page(
      '<h1>Builds</h1><script>console.log(1)</script><style>a{}</style><button type="button">ALL</button><span aria-hidden="true">→</span><p hidden>Hidden.</p><p>Kept.</p>'
    )
  );
  for (const noise of ['console.log', 'a{}', 'ALL', '→', 'Hidden.']) {
    assert.equal(markdown.includes(noise), false, noise);
  }
  assert.match(markdown, /Kept\./);
});

test('adjacent element siblings do not concatenate into one word', () => {
  // The changelog rows are three CSS-blocked spans with no whitespace between them; naive
  // conversion yields "02 AUG 2026featureA guest book an agent can sign".
  const markdown = pageToMarkdown(
    page(
      '<h1>Home</h1><ol><li><a href="/changelog/x"><span><time datetime="2026-08-02">02 AUG 2026</time><span>feature</span></span><span>A guest book</span></a></li></ol>'
    )
  );
  assert.match(markdown, /02 AUG 2026 feature A guest book/);
});

test('code blocks keep their whitespace', () => {
  const markdown = pageToMarkdown(
    page('<h1>Page</h1><pre><code>const a = 1;\nconst b = 2;</code></pre>')
  );
  assert.match(markdown, /```\nconst a = 1;\nconst b = 2;\n```/);
});

test('frontmatter carries the head metadata, decoded', () => {
  assert.deepEqual(extractMetadata(page('<h1>x</h1>')), {
    title: 'Page — Matt Pyle',
    description: 'A page.',
    canonical: 'https://www.mattpyle.com/page/',
  });

  const markdown = pageToMarkdown(page('<h1>Page</h1>'));
  assert.match(markdown, /^---\n/);
  assert.match(markdown, /title: "Page — Matt Pyle"/);
  assert.match(markdown, /canonical: https:\/\/www\.mattpyle\.com\/page\//);
  assert.match(markdown, /source: https:\/\/www\.mattpyle\.com\/page\//);
});
