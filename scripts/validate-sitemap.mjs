import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { readWritingMetadata } from './lib/writing-metadata.mjs';
import {
  STATIC_ROUTE_LASTMOD,
  latestDate,
  resolveSitemapLastmod,
} from '../src/data/sitemap-lastmod.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const dist = join(root, 'dist');
const canonicalOrigin = 'https://www.mattpyle.com';
const parser = new XMLParser({ ignoreAttributes: false });
const failures = [];

function parseXml(filename) {
  const source = readFileSync(join(dist, filename), 'utf8');
  const valid = SyntaxValidator.validate(source);
  if (valid !== true) {
    failures.push(`${filename}: invalid XML at line ${valid.err.line}, column ${valid.err.col}: ${valid.err.msg}`);
    return {};
  }
  return parser.parse(source);
}

function asArray(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function builtHtmlPath(pathname) {
  return pathname === '/'
    ? join(dist, 'index.html')
    : join(dist, ...pathname.split('/').filter(Boolean), 'index.html');
}

const writingDir = join(root, 'src', 'content', 'writing');
const writingMetadata = readWritingMetadata(writingDir);
const expected = new Map();

for (const pathname of Object.keys(STATIC_ROUTE_LASTMOD)) {
  expected.set(`${canonicalOrigin}${pathname}`, resolveSitemapLastmod(pathname, writingMetadata));
}

for (const [slug, entry] of writingMetadata) {
  if (entry.draft) continue;
  const pathname = `/writing/${slug}/`;
  expected.set(`${canonicalOrigin}${pathname}`, resolveSitemapLastmod(pathname, writingMetadata));
}

const child = parseXml('sitemap-0.xml');
const index = parseXml('sitemap-index.xml');
const urls = asArray(child.urlset?.url);
const actualLocations = new Set(urls.map(({ loc }) => loc));

for (const location of expected.keys()) {
  if (!actualLocations.has(location)) failures.push(`sitemap-0.xml: missing ${location}`);
}
for (const location of actualLocations) {
  if (!expected.has(location)) failures.push(`sitemap-0.xml: unexpected or non-page URL ${location}`);
}

const today = new Date().toISOString().slice(0, 10);
for (const item of urls) {
  const location = item.loc;
  const expectedDate = expected.get(location);
  const actualDate = typeof item.lastmod === 'string' ? item.lastmod.slice(0, 10) : '';

  if (!/^https:\/\/www\.mattpyle\.com\/.+|^https:\/\/www\.mattpyle\.com\/$/.test(location)) {
    failures.push(`${location}: URL must use the canonical HTTPS www host`);
  }
  if (!location.endsWith('/')) failures.push(`${location}: canonical page URL must have a trailing slash`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(actualDate)) failures.push(`${location}: missing or invalid lastmod`);
  if (actualDate > today) failures.push(`${location}: lastmod ${actualDate} is in the future`);
  if (expectedDate && actualDate !== expectedDate) {
    failures.push(`${location}: expected lastmod ${expectedDate}, received ${actualDate || 'none'}`);
  }
  if ('priority' in item || 'changefreq' in item) {
    failures.push(`${location}: priority/changefreq must not be emitted`);
  }

  const pathname = new URL(location).pathname;
  const htmlPath = builtHtmlPath(pathname);
  if (!existsSync(htmlPath)) {
    failures.push(`${location}: no built HTML page at ${htmlPath}`);
    continue;
  }
  const html = readFileSync(htmlPath, 'utf8');
  if (!html.includes(`<link rel="canonical" href="${location}">`)) {
    failures.push(`${location}: built page lacks an exact self-canonical link`);
  }
  if (/<meta[^>]+(?:name|property)=["']robots["'][^>]+noindex/i.test(html)) {
    failures.push(`${location}: built page is noindex`);
  }
}

const indexEntries = asArray(index.sitemapindex?.sitemap);
const expectedChildUrl = `${canonicalOrigin}/sitemap-0.xml`;
if (indexEntries.length !== 1 || indexEntries[0]?.loc !== expectedChildUrl) {
  failures.push(`sitemap-index.xml: expected one child at ${expectedChildUrl}`);
}
const newestExpectedDate = latestDate(...expected.values());
const indexDate = typeof indexEntries[0]?.lastmod === 'string'
  ? indexEntries[0].lastmod.slice(0, 10)
  : '';
if (indexDate !== newestExpectedDate) {
  failures.push(`sitemap-index.xml: expected child lastmod ${newestExpectedDate}, received ${indexDate || 'none'}`);
}

const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
if (!robots.includes(`Sitemap: ${canonicalOrigin}/sitemap-index.xml`)) {
  failures.push('robots.txt: missing canonical sitemap-index.xml reference');
}

if (failures.length > 0) {
  console.error('validate-sitemap: validation failed:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`validate-sitemap: ${urls.length} canonical URLs have accurate lastmod values; XML, canonicals, index, and robots reference are valid.`);
