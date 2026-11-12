#!/usr/bin/env node
/**
 * Fix log entries: extract the facts of each fix from its finding and its fix pull
 * request, and write one entry file per fix into `src/content/fixes/`.
 *
 *   node scripts/fix-log-entries.mjs <findings-dir>           write missing entries
 *   node scripts/fix-log-entries.mjs <findings-dir> --check   report, write nothing
 *   node scripts/fix-log-entries.mjs <findings-dir> --only MP-109,MP-135
 *
 * <findings-dir> is a folder of finding files, one per finding, with YAML
 * frontmatter (`key_short`, `status`, `links.pr`, `verify`, …) and a
 * `## Verification` section. The findings are private; this script reads them and
 * writes only the public facts.
 *
 * An entry is written once. The script never overwrites a file that exists, so a
 * person's edit to an entry always wins. A new entry has empty `title`, `lead` and
 * `measures` and no story: the schema refuses it until someone writes them under
 * `agents/steward/briefs/fix-log.md`.
 *
 * The launch set is every finding that is `resolved` or `reopened` and has a fix
 * pull request. A reopened finding is the loop's own mistake and stays in the log.
 *
 * Left out on purpose: the verdict reason, workflow identifiers, preview hostnames,
 * and the name of whatever system measured a side. `--check` sweeps the entries for
 * the strings those would leave behind.
 *
 * The pull request facts come from `gh pr view`, so writing needs the GitHub CLI
 * with read access to the repository. `--check` needs no network.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRIES_DIR = path.join(ROOT, 'src/content/fixes');
const ORIGIN = 'https://www.mattpyle.com';
const REPO = 'mattpyle/mattpyle.com-website';

/** Strings an entry must never hold: they come from workflow ids, previews and private paths. */
export const FORBIDDEN = ['verify/', 'finding/', 'vercel.app', 'docs/', '.claude/'];

// ── Reading a finding ─────────────────────────────────────────────────────

function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  return { data: yaml.load(m[1]) ?? {}, body: m[2] };
}

/** The text of the last `## <name>` section, up to the next `## ` heading. */
function section(body, name) {
  const parts = body.split(/^## /m).filter((p) => p.startsWith(`${name}\n`));
  return parts.length ? parts.at(-1).slice(name.length + 1) : '';
}

/** `2026-11-10T07:30Z` style stamps, and full ISO instants, as an ISO string. */
function iso(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string' || !v) return null;
  const s = v.replace(/T(\d{2})(\d{2})Z$/, 'T$1:$2:00Z');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `1. Pass, `text` on <url> [at 390x844]. Expected: X. Measured: Y.`, or `on 3 URLs (<url>, <url>, <url>)`. */
const CHECK_LINE = /^\d+\. (Pass|Fail), `(\w+)` on (?:\d+ URLs \(([^)]*)\)|(\S+?))(?: at (\d+x\d+))?\. Expected: ([\s\S]*)\. Measured: ([\s\S]*?)\.?$/;

/** A quoted string that holds escaped quotes reads better as code: `href="/webmcp"`. */
const unquote = (s) =>
  s.replace(/"((?:[^"\\]|\\.)*)"/g, (m, inner) => (inner.includes('\\"') ? '`' + inner.replace(/\\"/g, '"') + '`' : m));

function parseChecks(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(CHECK_LINE);
    if (!m) continue;
    out.push({
      passed: m[1] === 'Pass',
      method: m[2],
      urls: (m[3] ? m[3].split(', ') : [m[4]]).map(sitePath),
      ...(m[5] ? { viewport: m[5] } : {}),
      expected: unquote(m[6]),
      measured: unquote(m[7]),
    });
  }
  return out;
}

/** A production URL as a site path; anything else as it is. */
function sitePath(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  return u.origin === ORIGIN ? `${u.pathname}${u.search}${u.hash}` : url;
}

const VERIFIED_LINE = /^Steward (?:ran this finding's checks against production|confirmed this finding's fix by its deploy) at (\S+?)\. Outcome: (\w+)\./m;

/** Everything an entry needs from one finding file, or null when it is not in the log. */
export function readFinding(file) {
  const parsed = splitFrontmatter(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  if (!parsed) return null;
  const { data: fm, body } = parsed;
  const prUrl = fm.links?.pr;
  if (!prUrl || !['resolved', 'reopened'].includes(fm.status)) return null;

  const verification = section(body, 'Verification');
  const verified = verification.match(VERIFIED_LINE);
  const checks = parseChecks(verification);
  // A check measured at the verdict is a true before. Match it to the after by URL and expectation.
  const before = parseChecks(section(body, 'Measured at the verdict'));
  for (const c of checks) {
    const b = before.find((x) => x.urls.join() === c.urls.join() && x.expected === c.expected);
    if (b) c.before = b.measured;
  }

  // A check's `url` is one URL or a list of them.
  const firstVerifyUrl = Array.isArray(fm.verify) ? [fm.verify[0]?.url].flat()[0] : undefined;
  const happenedUrl = section(body, 'What happened').match(/https?:\/\/[^\s,)`]+/)?.[0];

  return {
    key: fm.key_short,
    type: fm.type,
    kind: fm.kind,
    status: fm.status === 'reopened' ? 'reopened' : 'fixed',
    confirmedBy: fm.resolved_by === 'deploy' || verified?.[2] === 'confirmed' ? 'deploy' : 'check',
    where: sitePath(firstVerifyUrl ?? happenedUrl ?? ORIGIN),
    pr: Number(String(prUrl).split('/').pop()),
    found: typeof fm.first_seen === 'string' ? fm.first_seen : iso(fm.first_seen)?.slice(0, 10),
    approved: iso(fm.verdict_at),
    verified: verified ? iso(verified[1]) : null,
    checks,
  };
}

export function readFindings(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !['INDEX.md', 'README.md'].includes(f))
    .map((f) => readFinding(path.join(dir, f)))
    .filter(Boolean);
}

// ── Reading the entries ───────────────────────────────────────────────────

export function readEntries(dir = ENTRIES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
      const parsed = splitFrontmatter(text);
      return { file: f, text, key: parsed?.data?.key, data: parsed?.data ?? {}, body: parsed?.body ?? '' };
    });
}

export const entryFile = (key) => `${key.toLowerCase()}.md`;

// ── Writing an entry ──────────────────────────────────────────────────────

function pullRequest(n) {
  const out = execFileSync('gh', ['pr', 'view', String(n), '--repo', REPO, '--json', 'title,createdAt,mergedAt'], { encoding: 'utf8' });
  const pr = JSON.parse(out);
  return { number: n, title: pr.title, opened: pr.createdAt, merged: pr.mergedAt };
}

export function entryText(f, pr) {
  const facts = {
    key: f.key,
    title: '',
    lead: '',
    type: f.type,
    kind: f.kind,
    status: f.status,
    confirmedBy: f.confirmedBy,
    where: f.where,
    visual: false,
    found: f.found,
    approved: f.approved,
    verified: f.verified,
    changes: [pr],
    measures: [],
    checks: f.checks,
  };
  const head = yaml.dump(facts, { lineWidth: -1, quotingType: '"', noRefs: true });
  return `---\n${head}---\n`;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--') && !/^MP-/.test(a));
  const check = args.includes('--check');
  const onlyArg = args[args.indexOf('--only') + 1];
  const only = args.includes('--only') && onlyArg ? new Set(onlyArg.split(',')) : null;
  if (!dir || !fs.existsSync(dir)) {
    console.error('usage: node scripts/fix-log-entries.mjs <findings-dir> [--check] [--only MP-1,MP-2]');
    process.exit(2);
  }

  const findings = readFindings(dir);
  const entries = readEntries();
  const have = new Set(entries.map((e) => e.key));

  if (check) {
    const missing = findings.filter((f) => !have.has(f.key)).map((f) => f.key);
    const counts = new Map();
    for (const e of entries) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
    const repeated = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
    const wanted = new Set(findings.map((f) => f.key));
    const extra = entries.filter((e) => !wanted.has(e.key)).map((e) => e.key);
    const unwritten = entries.filter((e) => !e.data.title || !e.data.lead || !e.body.trim()).map((e) => e.key);
    const leaks = entries.flatMap((e) => FORBIDDEN.filter((s) => e.text.includes(s)).map((s) => `${e.file}: ${s}`));
    console.log(`findings in the log: ${findings.length}; entries: ${entries.length}`);
    console.log(`missing: ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`);
    console.log(`repeated: ${repeated.length}${repeated.length ? ` (${repeated.join(', ')})` : ''}`);
    console.log(`not in the log: ${extra.length}${extra.length ? ` (${extra.join(', ')})` : ''}`);
    console.log(`unwritten: ${unwritten.length}${unwritten.length ? ` (${unwritten.join(', ')})` : ''}`);
    console.log(`forbidden strings: ${leaks.length}${leaks.length ? `\n  ${leaks.join('\n  ')}` : ''}`);
    process.exit(missing.length || repeated.length || leaks.length ? 1 : 0);
  }

  fs.mkdirSync(ENTRIES_DIR, { recursive: true });
  let wrote = 0;
  for (const f of findings) {
    if (only && !only.has(f.key)) continue;
    const file = path.join(ENTRIES_DIR, entryFile(f.key));
    if (have.has(f.key) || fs.existsSync(file)) continue;
    fs.writeFileSync(file, entryText(f, pullRequest(f.pr)), { flag: 'wx' });
    console.log(`wrote ${path.relative(ROOT, file)}`);
    wrote++;
  }
  console.log(`${wrote} written; ${findings.length - wrote} already had an entry or were skipped`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv);
