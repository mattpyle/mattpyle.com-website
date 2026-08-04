#!/usr/bin/env node
/**
 * Byte-identity check for the agent surfaces the middleware now watches.
 *
 * The middleware logs and calls next(); nothing about the response should change. "Should" is not
 * evidence, so this captures body hash, status, and the headers that would betray a regression
 * (Content-Type, Cache-Control, Vary, CORS) for every surface, and diffs two captures.
 *
 * Capture against production before the deploy, again after, and compare:
 *
 *   node scripts/agent-surface-parity.mjs capture https://www.mattpyle.com before.json
 *   node scripts/agent-surface-parity.mjs capture https://www.mattpyle.com after.json
 *   node scripts/agent-surface-parity.mjs compare before.json after.json
 *
 * The negotiated markdown routes are in the matrix too: they are the one thing on the site that a
 * middleware change could plausibly break, and they must answer exactly as before.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { AGENT_SURFACE_PATHS } from '../src/lib/agent-surfaces.mjs';

const WATCHED_HEADERS = ['content-type', 'cache-control', 'vary', 'access-control-allow-origin', 'location'];

const PROBES = [
  ...AGENT_SURFACE_PATHS.map((path) => ({ path, accept: '*/*' })),
  { path: '/.well-known/agent-card.json', accept: '*/*' },
  // Content negotiation, unchanged behaviour expected on both sides of the branch.
  { path: '/writing/', accept: 'text/html' },
  { path: '/changelog/', accept: 'text/html' },
];

async function probe(origin, { path, accept }) {
  const response = await fetch(new URL(path, origin), { headers: { accept, 'user-agent': 'agent-surface-parity' } });
  const body = Buffer.from(await response.arrayBuffer());
  const headers = {};
  for (const key of WATCHED_HEADERS) {
    const value = response.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  return {
    key: `${path} (accept: ${accept})`,
    status: response.status,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    headers,
  };
}

async function capture(origin, outfile) {
  const rows = [];
  for (const spec of PROBES) {
    const row = await probe(origin, spec);
    rows.push(row);
    console.log(`${row.status} ${row.bytes.toString().padStart(7)}b  ${row.key}`);
  }
  writeFileSync(outfile, `${JSON.stringify({ origin, capturedAt: new Date().toISOString(), rows }, null, 2)}\n`);
  console.log(`\nwrote ${outfile}`);
}

function compare(beforeFile, afterFile) {
  const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
  const after = JSON.parse(readFileSync(afterFile, 'utf8'));
  const index = new Map(after.rows.map((row) => [row.key, row]));
  const differences = [];

  for (const row of before.rows) {
    const other = index.get(row.key);
    if (!other) {
      differences.push(`${row.key}: missing from ${afterFile}`);
      continue;
    }
    const a = JSON.stringify({ ...row, key: undefined });
    const b = JSON.stringify({ ...other, key: undefined });
    if (a !== b) differences.push(`${row.key}:\n    before ${a}\n    after  ${b}`);
  }

  if (differences.length === 0) {
    console.log(`identical: ${before.rows.length} surfaces match, body and headers.`);
    return 0;
  }
  console.error(`${differences.length} difference(s):`);
  for (const difference of differences) console.error(`  ${difference}`);
  return 1;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'capture') {
  const [origin, outfile] = args;
  if (!origin || !outfile) {
    console.error('usage: agent-surface-parity.mjs capture <origin> <outfile>');
    process.exit(2);
  }
  await capture(origin, outfile);
} else if (command === 'compare') {
  const [beforeFile, afterFile] = args;
  if (!beforeFile || !afterFile) {
    console.error('usage: agent-surface-parity.mjs compare <before.json> <after.json>');
    process.exit(2);
  }
  process.exit(compare(beforeFile, afterFile));
} else {
  console.error('usage: agent-surface-parity.mjs capture <origin> <outfile> | compare <before.json> <after.json>');
  process.exit(2);
}
