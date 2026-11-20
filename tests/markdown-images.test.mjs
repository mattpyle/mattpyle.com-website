import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findImageTargets,
  isRelativeTarget,
  rewriteImagePaths,
  sourcePathFor,
} from '../src/lib/markdown-images.mjs';

/**
 * The rewrite that turns a body's source-relative image path into the address
 * the build serves the file at. The interesting part is what it leaves alone:
 * alt text, titles, code, and every target that already resolves.
 */

const ORIGIN = 'https://www.mattpyle.com';
const FILE = 'src/content/writing/a-post.md';
const BUILT = {
  'src/assets/a11y-bot-form.png': '/_astro/a11y-bot-form.Najibs_Z.png',
  'src/assets/writing/a-post/demo.gif': '/_astro/demo.CVBjMzRT.gif',
};
const lookup = (/** @type {string} */ path) => BUILT[/** @type {keyof typeof BUILT} */ (path)];
const rewrite = (/** @type {string} */ body, options = {}) =>
  rewriteImagePaths(body, { filePath: FILE, lookup, origin: ORIGIN, ...options });

test('a relative image becomes the absolute built address', () => {
  assert.equal(
    rewrite('Before.\n\n![A meme](../../assets/a11y-bot-form.png)\n\nAfter.'),
    `Before.\n\n![A meme](${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png)\n\nAfter.`
  );
});

test('the path resolves against the entry file, nested folders included', () => {
  assert.equal(sourcePathFor(FILE, '../../assets/writing/a-post/demo.gif'), 'src/assets/writing/a-post/demo.gif');
  assert.equal(sourcePathFor('src\\content\\writing\\a-post.md', '../../assets/a.png'), 'src/assets/a.png');
  assert.equal(
    rewrite('![x](../../assets/writing/a-post/demo.gif)'),
    `![x](${ORIGIN}/_astro/demo.CVBjMzRT.gif)`
  );
});

// Only the target's bytes change. The alt on this site carries the image's
// information, so an escape or a quote rewritten in passing is a regression.
test('alt text and titles are byte-identical', () => {
  const alt = 'Milhouse says "Remember A11y?" and calls sign\\_guestbook, then getTools() [twice] — é';
  for (const title of ['', ' "A \'quoted\' title"', " 'single'", ' (parenthesised)']) {
    const body = `![${alt}](../../assets/a11y-bot-form.png${title})`;
    assert.equal(rewrite(body), `![${alt}](${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png${title})`);
  }
  assert.equal(rewrite('![](../../assets/a11y-bot-form.png)'), `![](${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png)`);
});

test('an angle-bracket target is rewritten inside its brackets', () => {
  assert.equal(
    rewrite('![x](<../../assets/a11y-bot-form.png>)'),
    `![x](<${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png>)`
  );
});

test('several images on one line and across lines are all rewritten', () => {
  const body = '![a](../../assets/a11y-bot-form.png) and ![b](../../assets/writing/a-post/demo.gif)\n![c](../../assets/a11y-bot-form.png)';
  assert.equal(
    rewrite(body),
    `![a](${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png) and ![b](${ORIGIN}/_astro/demo.CVBjMzRT.gif)\n![c](${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png)`
  );
});

test('targets that already resolve are left alone', () => {
  const body = [
    '![public](/images/from-public.png)',
    '![remote](https://example.com/a.png)',
    '![protocol-relative](//example.com/a.png)',
    '![data](data:image/png;base64,AAAA)',
    '![fragment](#figure)',
    '[a link, not an image](../../assets/a11y-bot-form.png)',
  ].join('\n');
  assert.equal(rewrite(body), body);
});

test('an image inside a fenced block is not rewritten', () => {
  for (const [open, close] of [['```md', '```'], ['~~~', '~~~'], ['````', '````']]) {
    const body = `Text.\n\n${open}\n![x](../../assets/a11y-bot-form.png)\n${close}\n\nMore.`;
    assert.equal(rewrite(body), body);
  }
  // A shorter fence inside a longer one does not close it.
  const nested = '````md\n```\n![x](../../assets/a11y-bot-form.png)\n```\n````';
  assert.equal(rewrite(nested), nested);
  // An unclosed fence runs to the end of the document.
  const unclosed = '```\n![x](../../assets/a11y-bot-form.png)';
  assert.equal(rewrite(unclosed), unclosed);
});

test('an image after a closed fence is rewritten', () => {
  assert.equal(
    rewrite('```\ncode\n```\n\n![x](../../assets/a11y-bot-form.png)'),
    `\`\`\`\ncode\n\`\`\`\n\n![x](${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png)`
  );
});

test('an image inside inline code is not rewritten, one beside it is', () => {
  const code = 'Write `![alt](../../assets/a11y-bot-form.png)` or ``![a](../../assets/a11y-bot-form.png) with a ` tick``.';
  assert.equal(rewrite(code), code);
  assert.equal(
    rewrite('`code` ![x](../../assets/a11y-bot-form.png) `more`'),
    `\`code\` ![x](${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png) \`more\``
  );
});

// No content entry uses either form today. Both are rewritten rather than
// ignored, so the day one appears it does not reach an agent as a source path.
test('a reference-style image has its definition rewritten', () => {
  const body = [
    '![Full][meme] ![meme][] ![Demo] [a link][other]',
    '',
    '[meme]: ../../assets/a11y-bot-form.png "Title"',
    '[DEMO]: <../../assets/writing/a-post/demo.gif>',
    '[other]: ../somewhere/else.md',
  ].join('\n');
  assert.equal(
    rewrite(body),
    [
      '![Full][meme] ![meme][] ![Demo] [a link][other]',
      '',
      `[meme]: ${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png "Title"`,
      `[DEMO]: <${ORIGIN}/_astro/demo.CVBjMzRT.gif>`,
      '[other]: ../somewhere/else.md',
    ].join('\n')
  );
});

test('an HTML img with a relative src is rewritten, either quote', () => {
  assert.equal(
    rewrite(`<img alt="a > b" src="../../assets/a11y-bot-form.png" width="4">\n<IMG src='../../assets/writing/a-post/demo.gif'>`),
    `<img alt="a > b" src="${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png" width="4">\n<IMG src='${ORIGIN}/_astro/demo.CVBjMzRT.gif'>`
  );
  const untouched = '<img src="/images/a.png"> <img data-src="../../assets/a11y-bot-form.png" src="https://example.com/a.png">';
  assert.equal(rewrite(untouched), untouched);
});

// The prerendered llms-full.txt calls it this way, so the build fails.
test('an image with no built address throws and names the entry, line and path', () => {
  assert.throws(
    () => rewrite('One.\n\n![x](../../assets/missing.png)'),
    (error) =>
      error instanceof Error &&
      error.message.includes(FILE) &&
      error.message.includes('line 3') &&
      error.message.includes('../../assets/missing.png') &&
      error.message.includes('src/assets/missing.png')
  );
  // Relative to something that is not an image under src/assets.
  assert.throws(() => rewrite('![x](./neighbour.png)'), /src\/content\/writing\/neighbour\.png/);
  // No file path to resolve against.
  assert.throws(() => rewrite('![x](../../assets/a11y-bot-form.png)', { filePath: undefined }), /no built address/);
});

// The on-demand routes call it this way: only a draft can reach them with a
// broken image, and one image left as written beats a 500 for the document.
test('with onUnresolved the image is reported and left as written, the rest rewritten', () => {
  /** @type {unknown[]} */
  const problems = [];
  const body = '![ok](../../assets/a11y-bot-form.png)\n![bad](../../assets/missing.png)\n![ok](../../assets/writing/a-post/demo.gif)';
  assert.equal(
    rewrite(body, { onUnresolved: (/** @type {unknown} */ problem) => problems.push(problem) }),
    `![ok](${ORIGIN}/_astro/a11y-bot-form.Najibs_Z.png)\n![bad](../../assets/missing.png)\n![ok](${ORIGIN}/_astro/demo.CVBjMzRT.gif)`
  );
  assert.deepEqual(problems, [
    { target: '../../assets/missing.png', line: 2, sourcePath: 'src/assets/missing.png', filePath: FILE },
  ]);
});

test('a built path with a space is percent-encoded', () => {
  assert.equal(
    rewriteImagePaths('![x](<../../assets/two words.png>)', {
      filePath: FILE,
      lookup: (path) => (path === 'src/assets/two words.png' ? '/_astro/two words.abc.png' : undefined),
      origin: ORIGIN,
    }),
    `![x](<${ORIGIN}/_astro/two%20words.abc.png>)`
  );
  assert.equal(sourcePathFor(FILE, '../../assets/two%20words.png?v=1#top'), 'src/assets/two words.png');
});

test('findImageTargets reports every image outside code, with its line', () => {
  const body = '![a](../a.png)\n`![b](../b.png)`\n![c](/c.png)\n<img src="d.png">';
  assert.deepEqual(
    findImageTargets(body).map(({ target, kind, line }) => ({ target, kind, line })),
    [
      { target: '../a.png', kind: 'inline', line: 1 },
      { target: '/c.png', kind: 'inline', line: 3 },
      { target: 'd.png', kind: 'html', line: 4 },
    ]
  );
  assert.equal(isRelativeTarget('../a.png'), true);
  assert.equal(isRelativeTarget('/c.png'), false);
});

// The corpus check. The on-demand `.md` routes leave no build output to read, and
// a draft never reaches llms-full.txt, so this is what holds them: every relative
// image in every content body is an image file under src/assets, on disk.
test('every relative image in src/content resolves to a file under src/assets', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  /** @param {string} dir @returns {string[]} */
  const markdownUnder = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return markdownUnder(full);
      return /\.mdx?$/.test(entry.name) ? [full] : [];
    });

  const failures = [];
  let images = 0;
  for (const file of markdownUnder(join(root, 'src', 'content'))) {
    const filePath = relative(root, file).split(sep).join('/');
    const source = readFileSync(file, 'utf8');
    // Body only: frontmatter paths are held by scripts/validate-content-references.mjs.
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    rewriteImagePaths(body, {
      filePath,
      origin: ORIGIN,
      lookup: (sourcePath) => {
        const ok =
          /^src\/assets\/.+\.(png|jpe?g|gif|webp|avif|svg)$/.test(sourcePath) && existsSync(join(root, sourcePath));
        if (ok) images += 1;
        return ok ? `/_astro/${sourcePath.split('/').pop()}` : undefined;
      },
      onUnresolved: ({ target, line }) => failures.push(`${filePath} body line ${line}: ${target}`),
    });
  }
  assert.deepEqual(failures, [], 'a content body has a relative image that is not an image file under src/assets');
  // Three bodies carry four such images today; zero would mean the scan found nothing.
  assert.ok(images >= 4, `expected the corpus to carry relative images, found ${images}`);
});
