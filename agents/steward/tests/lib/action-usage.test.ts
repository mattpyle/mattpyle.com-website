import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseActionUsage } from '../../src/lib/action-usage.js';

/**
 * The OpenMetrics parser, against text the real endpoint produced.
 *
 * Both fixtures are captures of https://metrics.temporal.io/v1/metrics taken on
 * 2026-09-06, with the account id redacted and the second namespace renamed. A
 * hand-written sample would test this parser against an idea of the format;
 * these test it against the format, including the fourteen families it has to
 * ignore and the label sets it has to read past.
 *
 * `active-minute.txt` carries five added series below the real response, which
 * its own header comment names. The captured minute was one namespace starting
 * three workflows, so it could not on its own exercise a background series, a
 * second billable row, or another namespace's series arriving in the same
 * scrape — and that last one is the case with a real failure behind it.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'metrics');
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const ACTIVE = read('active-minute.txt');
const IDLE = read('idle-minute.txt');

const NS = 'steward.acct1';
const OTHER_NS = 'other-project.acct1';

test('foreground series are summed and the background series is left out', () => {
  const sample = parseActionUsage(ACTIVE, NS);
  // 0.050 (active) + 0.200 (passive) foreground. The 0.017 background series is
  // Temporal's own housekeeping, which no runaway loop shows up in.
  assert.equal(Number(sample.foregroundPerSecond.toFixed(3)), 0.25);
  assert.equal(sample.idle, false);
});

test('billable rows carry the action type and workflow type, fastest first', () => {
  const sample = parseActionUsage(ACTIVE, NS);
  assert.deepEqual(sample.billable, [
    { actionType: 'signal_workflow', workflowType: 'scorecardAuditWorkflow', rate: 0.133 },
    { actionType: 'start_workflow', workflowType: 'metricsProbeWorkflow', rate: 0.05 },
  ]);
});

test('another namespace on the same account is dropped, in both families', () => {
  // The metrics key is account-level, because that is the only scope the role
  // has, so every scrape carries every namespace. A sampler that summed what it
  // was given would alert Steward about another project's rate — and the other
  // namespace in this fixture is deliberately the fastest thing in it.
  const sample = parseActionUsage(ACTIVE, NS);
  assert.ok(sample.foregroundPerSecond < 1, 'the other namespace runs at 9/s and must not be counted');
  assert.ok(!sample.billable.some((r) => r.workflowType === 'hermesDailyBriefing'));

  // And read the other way round: asked for that namespace, it returns that one.
  const other = parseActionUsage(ACTIVE, OTHER_NS);
  assert.equal(other.foregroundPerSecond, 9);
  assert.deepEqual(other.billable.map((r) => r.workflowType), ['hermesDailyBriefing']);
});

test('an idle minute has neither family at all, and reads as idle rather than as zero', () => {
  // The real shape of most minutes in this namespace: the endpoint emits no
  // series for a family with nothing to report, so there is nothing to find.
  assert.ok(!IDLE.includes('temporal_cloud_v1_total_action_count'));
  const sample = parseActionUsage(IDLE, NS);
  assert.equal(sample.foregroundPerSecond, 0);
  assert.deepEqual(sample.billable, []);
  assert.equal(sample.idle, true);
});

test('a namespace with no series in a scrape that has some is idle too', () => {
  const sample = parseActionUsage(ACTIVE, 'nobody.acct1');
  assert.equal(sample.foregroundPerSecond, 0);
  assert.equal(sample.idle, true);
});

test('the other twelve families on the endpoint are ignored', () => {
  // `temporal_cloud_v1_operations_count` and `…_action_limit` both sit in these
  // fixtures at rates well above the alert threshold. Reading either as an
  // action count would alert every night.
  assert.ok(IDLE.includes('temporal_cloud_v1_action_limit'));
  assert.ok(IDLE.includes('temporal_cloud_v1_operations_count'));
  assert.equal(parseActionUsage(IDLE, NS).foregroundPerSecond, 0);
});

test('a family whose name is a prefix of another is not read as it', () => {
  // Nothing on the endpoint is shaped like this today. The guard is here
  // because the day one is added, the failure would be a silent wrong number
  // rather than an error.
  const text =
    'temporal_cloud_v1_total_action_count_v2{is_background="false",temporal_namespace="steward.acct1"} 99.000 1\n' +
    'temporal_cloud_v1_total_action_count{is_background="false",temporal_namespace="steward.acct1"} 1.500 1\n';
  assert.equal(parseActionUsage(text, NS).foregroundPerSecond, 1.5);
});

test('label order is not part of the format and is not relied on', () => {
  const text =
    'temporal_cloud_v1_billable_action_count{temporal_workflow_type="w",temporal_namespace="steward.acct1",action_type="a"} 2.000 1\n';
  assert.deepEqual(parseActionUsage(text, NS).billable, [
    { actionType: 'a', workflowType: 'w', rate: 2 },
  ]);
});

test('a malformed series is skipped rather than parsed into a number', () => {
  const text =
    'temporal_cloud_v1_total_action_count{is_background="false",temporal_namespace="steward.acct1"} nonsense 1\n' +
    'temporal_cloud_v1_total_action_count{is_background="false",temporal_namespace="steward.acct1"} 0.400 1\n';
  const sample = parseActionUsage(text, NS);
  assert.equal(sample.foregroundPerSecond, 0.4);
});
