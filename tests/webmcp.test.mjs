import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/dom-stub.mjs';
import { createTools, registerTools, resolveModelContext } from '../src/lib/webmcp-tools.mjs';
import { STORAGE_KEY } from '../src/lib/appearance.mjs';

const INDEX = {
  generated: '2026-07-17T00:00:00.000Z',
  site: {
    name: 'Matt Pyle',
    url: 'https://www.mattpyle.com/',
    description: 'Growth marketer and hobbyist builder.',
    person: {
      name: 'Matt Pyle',
      jobTitle: 'Director of Growth',
      worksFor: 'Temporal Technologies',
      url: 'https://www.mattpyle.com/',
      sameAs: ['https://github.com/mattpyle', 'https://linkedin.com/in/matt-pyle'],
    },
    sections: [{ name: 'Writing', url: 'https://www.mattpyle.com/writing', summary: 'All writing.' }],
  },
  writing: [
    {
      title: 'I turned on a screen reader',
      slug: 'i-turned-on-a-screen-reader',
      url: 'https://www.mattpyle.com/writing/i-turned-on-a-screen-reader',
      date: '2026-07-12T00:00:00.000Z',
      updated: '2026-07-14T00:00:00.000Z',
      tags: ['accessibility', 'agents'],
      description: 'What VoiceOver taught me about the accessibility tree.',
    },
    {
      title: 'Fixture post two',
      slug: 'fixture-post-two',
      url: 'https://www.mattpyle.com/writing/fixture-post-two',
      date: '2026-07-05T00:00:00.000Z',
      tags: ['agents'],
      description: 'Auditing the same page with three different crawlers.',
    },
  ],
  builds: [
    {
      title: 'Scorecard',
      slug: 'scorecard',
      url: 'https://www.mattpyle.com/builds',
      date: '2026-06-01T00:00:00.000Z',
      status: 'live',
      tags: ['astro'],
      description: 'A verified accessibility and performance snapshot.',
      github: 'https://github.com/mattpyle/scorecard',
    },
  ],
  changelog: [
    {
      title: 'Self-hosted fonts, Performance back to 100',
      slug: 'self-hosted-fonts',
      url: 'https://www.mattpyle.com/changelog/self-hosted-fonts',
      date: '2026-07-14T00:00:00.000Z',
      type: 'infra',
      significance: 'major',
      tags: ['performance'],
      description: 'Dropped the render-blocking Google Fonts stylesheet for self-hosted woff2 files.',
    },
  ],
};

const getIndex = async () => INDEX;
const toolsByName = () => Object.fromEntries(createTools(getIndex).map((t) => [t.name, t]));

test('registers the three read-only tools plus the set_appearance write tool', async () => {
  const registered = [];
  const mc = { registerTool: async (tool) => registered.push(tool) };

  await registerTools(mc, getIndex);

  assert.deepEqual(
    registered.map((t) => t.name),
    ['describe_site', 'get_recent_writing', 'search_content', 'set_appearance']
  );
});

test('every tool declares an object inputSchema and an execute handler', () => {
  for (const tool of createTools(getIndex)) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
});

test('search_content and set_appearance require input; the read-only tools do not', () => {
  const tools = toolsByName();

  assert.deepEqual(tools.search_content.inputSchema.required, ['query']);
  assert.deepEqual(tools.set_appearance.inputSchema.required, ['mode']);
  assert.equal(tools.describe_site.inputSchema.required, undefined);
  assert.equal(tools.get_recent_writing.inputSchema.required, undefined);
});

test('describe_site returns the author entity, site, and section map', async () => {
  const result = await toolsByName().describe_site.execute({});

  assert.equal(result.person.name, 'Matt Pyle');
  assert.equal(result.person.jobTitle, 'Director of Growth');
  assert.equal(result.person.worksFor, 'Temporal Technologies');
  assert.deepEqual(result.site, {
    name: 'Matt Pyle',
    url: 'https://www.mattpyle.com/',
    description: 'Growth marketer and hobbyist builder.',
  });
  assert.equal(result.sections[0].name, 'Writing');
});

test('get_recent_writing defaults to 5 posts, newest first', async () => {
  const { posts } = await toolsByName().get_recent_writing.execute({});

  assert.equal(posts.length, 2);
  assert.equal(posts[0].title, 'I turned on a screen reader');
  assert.equal(posts[0].updated, '2026-07-14T00:00:00.000Z');
  assert.equal('updated' in posts[1], false);
});

test('get_recent_writing honours limit and clamps it to 1-20', async () => {
  const tool = toolsByName().get_recent_writing;

  assert.equal((await tool.execute({ limit: 1 })).posts.length, 1);
  assert.equal((await tool.execute({ limit: 0 })).posts.length, 1);
  assert.equal((await tool.execute({ limit: 999 })).posts.length, 2);
});

test('get_recent_writing filters by tag, case-insensitively', async () => {
  const tool = toolsByName().get_recent_writing;

  assert.equal((await tool.execute({ tag: 'Accessibility' })).posts.length, 1);
  assert.equal((await tool.execute({ tag: 'agents' })).posts.length, 2);
  assert.deepEqual((await tool.execute({ tag: 'nonexistent' })).posts, []);
});

test('search_content matches title, description, and tags across writing, builds, and changelog', async () => {
  const tool = toolsByName().search_content;

  const byTitle = await tool.execute({ query: 'screen reader' });
  assert.equal(byTitle.results.length, 1);
  assert.equal(byTitle.results[0].type, 'writing');
  assert.equal(byTitle.results[0].url, 'https://www.mattpyle.com/writing/i-turned-on-a-screen-reader');

  const byTag = await tool.execute({ query: 'astro' });
  assert.equal(byTag.results.length, 1);
  assert.equal(byTag.results[0].type, 'build');
  assert.equal(byTag.results[0].status, 'live');

  const byDescription = await tool.execute({ query: 'crawlers' });
  assert.equal(byDescription.results[0].title, 'Fixture post two');

  // "performance" appears in both the writing description ("performance snapshot" is a
  // build, actually) — assert the changelog entry is found and carries its significance.
  const changelogHit = await tool.execute({ query: 'self-hosted fonts' });
  const clResult = changelogHit.results.find((r) => r.type === 'changelog');
  assert.ok(clResult, 'expected a changelog result for "self-hosted fonts"');
  assert.equal(clResult.url, 'https://www.mattpyle.com/changelog/self-hosted-fonts');
  assert.equal(clResult.significance, 'major');

  assert.deepEqual((await tool.execute({ query: 'nothing matches this' })).results, []);
});

test('search_content still works when the index predates the changelog field', async () => {
  const legacyIndex = { ...INDEX, changelog: undefined };
  const [tool] = createTools(async () => legacyIndex).filter((t) => t.name === 'search_content');
  const { results } = await tool.execute({ query: 'screen reader' });
  assert.equal(results.length, 1);
});

test('search_content ignores a blank query rather than matching everything', async () => {
  assert.deepEqual((await toolsByName().search_content.execute({ query: '   ' })).results, []);
});

test('set_appearance enumerates the allowed modes and switches the appearance', async () => {
  const tool = toolsByName().set_appearance;

  assert.deepEqual(tool.inputSchema.properties.mode.enum, ['modern', 'retro']);

  const result = await tool.execute({ mode: 'retro' });
  assert.equal(result.mode, 'retro');
  assert.match(result.message, /retro/i);
  assert.equal(document.documentElement.dataset.appearance, 'retro');
  assert.equal(localStorage.getItem(STORAGE_KEY), 'retro');
});

test('set_appearance falls back to modern for an invalid mode rather than erroring', async () => {
  const tool = toolsByName().set_appearance;

  const result = await tool.execute({ mode: 'chaos' });
  assert.equal(result.mode, 'modern');
  assert.match(result.message, /modern/i);
  assert.equal(document.documentElement.dataset.appearance, undefined);
});

test('resolveModelContext prefers document, falls back to navigator, else null', () => {
  const spec = { registerTool() {} };
  const trial = { registerTool() {} };

  assert.equal(resolveModelContext({ document: { modelContext: spec }, navigator: { modelContext: trial } }), spec);
  assert.equal(resolveModelContext({ document: {}, navigator: { modelContext: trial } }), trial);
  assert.equal(resolveModelContext({ document: {}, navigator: {} }), null);
  // A namespace without registerTool is not usable — treat it as absent.
  assert.equal(resolveModelContext({ document: { modelContext: {} }, navigator: {} }), null);
});
