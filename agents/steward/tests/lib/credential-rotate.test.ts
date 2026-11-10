import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CREDENTIALS, STEWARD_TARGET } from '../../src/lib/credentials.js';
import {
  RotateStopped,
  fieldByLabel,
  secretValues,
  buildTemplate,
  describePlan,
  durationDays,
  expiresAsIso,
  expiresValueFor,
  pickValueField,
  readyLineSays,
  redactSecrets,
  rotateCredential,
  type OpField,
  type OpItem,
  type RailwayDeployment,
  type RotateDeps,
  type RotateOptions,
  type RotateState,
  type RotateTimings,
} from '../../src/lib/credential-rotate.js';

/**
 * `steward credential rotate`, step by step, against fakes for tcld, op,
 * railway, the file system, the metrics endpoint and the prompt. Every secret is
 * built at run time: the gitleaks job scans full history.
 *
 * What these tests hold fixed:
 * 1. The order of the calls, and that a failed step stops the ones after it.
 * 2. That a rerun skips completed steps and never issues a second key.
 * 3. That nothing is deleted without a yes, and the new key is never deleted.
 * 4. That no log line carries a secret.
 */

const fresh = (prefix: string) => `${prefix}${randomBytes(24).toString('hex')}`;
const metrics = CREDENTIALS['temporal-metrics'];
const healthcheck = CREDENTIALS['healthcheck-base'];

const FAST: RotateTimings = {
  deployPollMs: 1,
  deployTimeoutMs: 20,
  readyTimeoutMs: 20,
  verifyTimeoutMs: 100,
  verifyFirstDelayMs: 1,
  verifyMaxDelayMs: 2,
  deleteTimeoutMs: 20,
  deletePollMs: 1,
};

const OPTIONS: RotateOptions = { duration: '90d', dryRun: false, fromOp: false, restart: false };

interface World {
  deps: RotateDeps;
  calls: string[];
  logs: string[];
  item: OpItem;
  states: Map<string, RotateState>;
  envWrites: Array<{ key: string; value: string }>;
  railwaySets: Array<{ name: string; value: string }>;
  deleted: string[];
  edits: Array<{ fields: Array<Record<string, unknown>> }>;
  secret: string;
  oldSecret: string;
  deployments: RailwayDeployment[];
  logsByDeployment: Map<string, string[]>;
  // Knobs a test sets before the run.
  tcld: boolean;
  confirms: boolean[];
  lines: string[];
  secrets: string[];
  problems: string[];
  samplerFailures: number;
  pingFailures: number;
  editFails: boolean;
  corruptEdit: boolean;
  dropBookkeeping: boolean;
  keyList: Array<{ id: string; name?: string; created?: string }>;
  keyListLingers: number;
  newDeploymentOnPush: boolean;
}

const PUSHED = '2026-11-09T06:00:00.000Z';

function world(overrides: Partial<World> = {}, oldKeyId: string | null = 'oldkey123'): World {
  const secret = fresh('new_');
  const oldSecret = fresh('old_');
  const item: OpItem = {
    fields: [
      { id: 'credential', label: 'credential', type: 'CONCEALED', value: oldSecret },
      { id: 'exp1', label: 'expires', type: 'DATE', value: '1790000000' },
      ...(oldKeyId ? [{ id: 'kid1', label: 'key_id', type: 'STRING', value: oldKeyId } as OpField] : []),
    ],
  };
  const w: World = {
    calls: [],
    logs: [],
    item,
    states: new Map(),
    envWrites: [],
    railwaySets: [],
    deleted: [],
    edits: [],
    secret,
    oldSecret,
    deployments: [{ id: 'dep-old', status: 'SUCCESS', createdAt: '2026-11-09T05:00:00.000Z' }],
    logsByDeployment: new Map(),
    tcld: true,
    confirms: [true],
    lines: [],
    secrets: [],
    problems: [],
    samplerFailures: 0,
    pingFailures: 0,
    editFails: false,
    corruptEdit: false,
    dropBookkeeping: false,
    keyList: oldKeyId ? [{ id: oldKeyId }] : [],
    keyListLingers: 0,
    newDeploymentOnPush: true,
    deps: undefined as unknown as RotateDeps,
    ...overrides,
  };
  const readyFor = (value: string) => `steward worker polling alerting: "configured" actionUsage: "${value}"`;
  const call = (name: string) => w.calls.push(name);
  w.deps = {
    now: () => new Date(PUSHED),
    sleep: async () => {
      call('sleep');
      await new Promise((r) => setTimeout(r, 1));
    },
    log: (line) => w.logs.push(line),
    isoDatePlus: (_from, days) => new Date(Date.parse('2026-11-09T12:00:00Z') + days * 86_400_000).toISOString().slice(0, 10),
    prompt: {
      secret: async () => {
        call('prompt.secret');
        return w.secrets.shift() ?? '';
      },
      line: async (_label, fallback = '') => {
        call('prompt.line');
        return w.lines.length ? w.lines.shift()! : fallback;
      },
      confirm: async (label) => {
        call(`confirm:${label}`);
        return w.confirms.length ? w.confirms.shift()! : false;
      },
    },
    state: {
      load: async (name) => w.states.get(name) ?? null,
      save: async (name, state) => void w.states.set(name, structuredClone(state)),
      clear: async (name) => void w.states.delete(name),
    },
    hasTcld: () => w.tcld,
    preflight: async () => {
      call('preflight');
      return w.problems;
    },
    tcld: {
      resolveServiceAccount: async (name) => {
        call(`tcld.resolve:${name}`);
        return 'sa-slug';
      },
      createKey: async (args) => {
        call('tcld.create');
        assert.equal(args.duration, '90d');
        assert.equal(args.serviceAccountId, 'sa-slug');
        return { keyId: 'newkey456', token: w.secret };
      },
      listKeys: async () => {
        call('tcld.list');
        if (w.keyListLingers > 0) {
          w.keyListLingers--;
          return [...w.keyList, ...w.deleted.map((id) => ({ id }))];
        }
        return w.keyList.filter((k) => !w.deleted.includes(k.id));
      },
      deleteKey: async (id) => {
        call(`tcld.delete:${id}`);
        w.deleted.push(id);
        // The issuer answers at once with Pending and drops the key from its list a moment later.
        w.keyListLingers = 2;
        return 'Pending';
      },
    },
    op: {
      readItem: async () => {
        call('op.read');
        return structuredClone(w.item);
      },
      editItem: async (_item, template) => {
        call('op.edit');
        if (w.editFails) throw new Error('1Password approval was refused');
        w.edits.push(template);
        for (const f of template.fields) {
          // A field the vault does not accept lands empty, as the 2026-11-09 live run saw for expires.
          if (w.dropBookkeeping && f.id !== 'credential') continue;
          const target = w.item.fields.find((x) => x.id === f.id || (f.label && x.label === f.label));
          const value = w.corruptEdit && f.id === 'credential' ? 'something else' : (f.value as string);
          if (target && f.type === 'CONCEALED') target.type = 'CONCEALED';
          // A template entry replaces the field it names by id: a label it omits is cleared, as the real vault did.
          if (target && f.id === target.id) target.label = typeof f.label === 'string' ? f.label : '';
          if (target) target.value = value;
          else w.item.fields.push({ id: `new-${f.label}`, label: String(f.label), type: String(f.type), value });
        }
      },
    },
    railway: {
      latestDeploymentId: async () => {
        call('railway.latest');
        return w.deployments[0]?.id ?? null;
      },
      setVariable: async (name, value) => {
        call('railway.set');
        w.railwaySets.push({ name, value });
        if (w.newDeploymentOnPush) {
          const id = `dep-new-${w.railwaySets.length}`;
          w.deployments.unshift({ id, status: 'SUCCESS', createdAt: '2026-11-09T06:00:05.000Z' });
          if (!w.logsByDeployment.has(id)) w.logsByDeployment.set(id, ['booting', readyFor('configured')]);
        }
      },
      deployments: async () => {
        call('railway.deployments');
        return w.deployments;
      },
      logs: async (id) => {
        call('railway.logs');
        return w.logsByDeployment.get(id) ?? [];
      },
    },
    env: {
      path: 'C:\\main\\agents\\steward\\.env',
      setLine: async (key, value) => {
        call('env.set');
        w.envWrites.push({ key, value });
      },
    },
    verifiers: {
      'action-usage': async (key) => {
        call('sample');
        assert.equal(key, w.secret);
        if (w.samplerFailures-- > 0) throw new Error('the metrics endpoint answered 403: Access Denied');
      },
      'ping-base': async () => {
        call('ping');
        if (w.pingFailures-- > 0) throw new Error('the alerting service answered 502');
      },
    },
  };
  return w;
}

const run = (w: World, spec = metrics, options: Partial<RotateOptions> = {}) =>
  rotateCredential(spec, STEWARD_TARGET, { ...OPTIONS, ...options }, w.deps, FAST);

async function stoppedAt(promise: Promise<unknown>): Promise<RotateStopped> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof RotateStopped, `expected RotateStopped, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the rotation to stop');
}

test('a dry run prints the plan and makes no call at all', async () => {
  const w = world();
  const result = await run(w, metrics, { dryRun: true });
  assert.equal(result.completed, false);
  assert.deepEqual(w.calls, [], 'no dependency is called, not even preflight');
  assert.ok(w.logs.some((l) => l.includes('tcld apikey create')));
  assert.ok(w.logs.some((l) => l.includes('railway variable set TEMPORAL_METRICS_API_KEY --stdin')));
  assert.ok(w.logs.some((l) => l.includes('7. retire')));
});

test('the dry run names the pasted path when tcld is absent', () => {
  const plan = describePlan(metrics, STEWARD_TARGET, OPTIONS, false, 'x/.env').join('\n');
  assert.match(plan, /tcld is not on PATH/);
  assert.match(plan, /tcld is absent, so you delete it/);
  const withTcld = describePlan(metrics, STEWARD_TARGET, OPTIONS, true, 'x/.env').join('\n');
  assert.match(withTcld, /service account/);
  assert.match(withTcld, /after you confirm/);
});

test('temporal-metrics rotates end to end through tcld, in order, and deletes the old key after a yes', async () => {
  const w = world();
  const result = await run(w);

  assert.equal(result.completed, true);
  assert.equal(result.retire, 'deleted');
  assert.equal(result.deploymentId, 'dep-new-1');
  assert.deepEqual(w.deleted, ['oldkey123']);
  assert.deepEqual(w.railwaySets, [{ name: 'TEMPORAL_METRICS_API_KEY', value: w.secret }]);
  assert.deepEqual(w.envWrites, [{ key: 'TEMPORAL_METRICS_API_KEY', value: w.secret }]);
  assert.equal(w.states.size, 0, 'state is cleared once the sequence is complete');

  const order = ['tcld.create', 'op.edit', 'railway.set', 'env.set', 'railway.logs', 'sample', 'tcld.delete:oldkey123'];
  const positions = order.map((c) => w.calls.indexOf(c));
  assert.ok(positions.every((p) => p >= 0), `every call happened: ${w.calls.join(', ')}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'the calls ran in step order');
  assert.ok(w.calls.indexOf('sample') < w.calls.indexOf('tcld.delete:oldkey123'), 'the old key goes only after verify');
});

test('the 1Password template carries the value, the expiry in the item\'s own form, and the key id', async () => {
  const w = world();
  await run(w);
  assert.equal(w.edits.length, 1);
  const byId = Object.fromEntries(w.edits[0].fields.map((f) => [String(f.id), f.value]));
  assert.equal(byId.credential, w.secret);
  // The fake item stores expires as epoch seconds, so the template does too: 90 days after the fake clock's day.
  assert.match(String(byId.exp1), /^\d{9,}$/);
  assert.equal(byId.kid1, 'newkey456');
});

test('no log line carries a secret, new or old', async () => {
  const w = world();
  w.deps.op.editItem = async () => {
    throw new Error(`op echoed the value back: ${w.secret}`);
  };
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'store');
  assert.ok(err.message.includes('[REDACTED]') && !err.message.includes(w.secret), 'the stop message is redacted');
  for (const line of w.logs) assert.ok(!line.includes(w.secret));

  const ok = world();
  await run(ok);
  for (const line of ok.logs) {
    assert.ok(!line.includes(ok.secret), `log leaks the new value: ${line}`);
    assert.ok(!line.includes(ok.oldSecret), `log leaks the old value: ${line}`);
  }
});

test('retire says the delete was requested, then reports when the key leaves the list', async () => {
  const w = world();
  await run(w);
  const lines = w.logs.filter((l) => l.includes('retire'));
  assert.ok(lines.some((l) => l.includes('delete requested for old key oldkey123') && l.includes('Pending')));
  assert.ok(lines.some((l) => l.includes('no longer appears')));
  assert.ok(w.calls.filter((c) => c === 'tcld.list').length >= 3, 'it looked more than once while the key lingered');
  assert.ok(!lines.some((l) => l.includes('deleted old key')), 'it does not claim the delete finished before it did');
});

test('retire still ends done when the key stays listed past the window, and says so', async () => {
  const w = world();
  const del = w.deps.tcld.deleteKey;
  w.deps.tcld.deleteKey = async (id) => {
    const state = await del(id);
    w.keyListLingers = 1000;
    return state;
  };
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.ok(w.logs.some((l) => l.includes('still listed after')));
});

test('retire reports a list that fails after the delete was requested, without undoing the retire', async () => {
  const w = world();
  const del = w.deps.tcld.deleteKey;
  w.deps.tcld.deleteKey = async (id) => {
    const state = await del(id);
    w.deps.tcld.listKeys = async () => {
      throw new Error('tcld: network down');
    };
    return state;
  };
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.ok(w.logs.some((l) => l.includes('could not confirm the delete') && l.includes('the request was sent')));
});

test('the old key is kept when Matt declines, and a rerun asks again without repeating any step', async () => {
  const w = world({ confirms: [false, true] });
  const first = await run(w);
  assert.equal(first.completed, false);
  assert.equal(first.retire, 'declined');
  assert.deepEqual(w.deleted, []);
  assert.deepEqual(first.remaining, ['retire']);
  assert.equal(w.states.size, 1, 'state stays so a rerun can finish');

  const createsBefore = w.calls.filter((c) => c === 'tcld.create').length;
  const second = await run(w);
  assert.equal(second.completed, true);
  assert.deepEqual(w.deleted, ['oldkey123']);
  assert.equal(w.calls.filter((c) => c === 'tcld.create').length, createsBefore, 'no second key is issued');
  assert.equal(w.railwaySets.length, 1, 'the variable is not pushed twice');
});

test('without a key_id on the item, retire lists the service account\'s keys and deletes only the one Matt picks', async () => {
  const w = world({ keyList: [{ id: 'newkey456', name: 'the new one' }, { id: 'k-a', name: 'first' }, { id: 'k-b', name: 'second' }], lines: ['', '', '2'] }, null);
  // lines: key id and expiry are not asked on the tcld path; the first answer is the pick.
  w.lines = ['2'];
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.deepEqual(w.deleted, ['k-b']);
  assert.ok(!w.deleted.includes('newkey456'));
  assert.ok(w.logs.some((l) => l.includes('1. k-a')));
  assert.ok(!w.logs.some((l) => l.includes('newkey456 (')), 'the new key is not offered');
});

test('without a key_id, an empty pick deletes nothing and leaves retire for a rerun', async () => {
  const w = world({ keyList: [{ id: 'k-a' }], lines: [''] }, null);
  const result = await run(w);
  assert.equal(result.completed, false);
  assert.equal(result.retire, 'declined');
  assert.deepEqual(w.deleted, []);
});

test('without a key_id and no other key on the account, there is nothing to delete', async () => {
  const w = world({ keyList: [{ id: 'newkey456' }] }, null);
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.deepEqual(w.deleted, []);
});

test('retire refuses to delete a key whose id equals the new key\'s', async () => {
  const w = world({ lines: ['1'], keyList: [{ id: 'newkey456' }, { id: 'oldkey123' }] });
  w.item.fields.find((f) => f.label === 'key_id')!.value = 'newkey456';
  // The old key id equals the new one only if the item already carried it; the store step then ignores
  // it, retire lists the account's other keys, and the new key is not among them.
  const result = await run(w);
  assert.ok(!w.deleted.includes('newkey456'));
  assert.deepEqual(w.deleted, ['oldkey123']);
  assert.equal(result.completed, true);
});

test('with tcld absent the value is pasted, and retire prints the Cloud steps instead of deleting', async () => {
  const pasted = fresh('pasted_');
  const w = world({ tcld: false, secrets: [pasted], lines: ['', '2027-02-01'] });
  w.secret = pasted;
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.equal(result.retire, 'manual');
  assert.deepEqual(w.deleted, []);
  assert.ok(!w.calls.includes('tcld.create'));
  assert.ok(w.logs.some((l) => l.includes('Open Temporal Cloud')));
  assert.ok(w.logs.some((l) => l.includes('delete key id oldkey123')));
  assert.deepEqual(w.railwaySets, [{ name: 'TEMPORAL_METRICS_API_KEY', value: pasted }]);
  const expires = w.item.fields.find((f) => f.label === 'expires')!.value!;
  assert.equal(expiresAsIso(expires), '2027-02-01');
});

test('the item layout 1Password really holds: built-in expires by id with no label, credential as a STRING', async () => {
  const w = world();
  const oldSecret = w.oldSecret;
  w.item = {
    fields: [
      { id: 'notesPlain', label: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: '' },
      { id: 'credential', label: '', type: 'STRING', value: oldSecret },
      { id: 'expires', label: '', type: 'STRING', value: String(Math.floor(Date.parse('2026-11-09T12:00:00Z') / 1000)) },
      { id: 'wuxmu2a3okectjag2eu5fyid5u', label: 'key_id', type: 'STRING', value: 'oldkey123' },
    ],
  };
  // The fake edit matches a template field to the item's field by id or label.
  const result = await run(w);
  assert.deepEqual(result.warnings, [], 'expires and key_id read back by id and by label');
  assert.equal(result.completed, true);
  const byId = Object.fromEntries(w.edits[0].fields.map((f) => [String(f.id), f.value]));
  assert.equal(byId.expires, String(Math.floor(Date.parse('2027-02-07T12:00:00Z') / 1000)), 'epoch seconds, as the item stores it');
  assert.equal(byId.wuxmu2a3okectjag2eu5fyid5u, 'newkey456');
});

test('the store step writes the value field as CONCEALED and converts a plain STRING credential', async () => {
  const w = world();
  w.item.fields[0] = { id: 'credential', label: '', type: 'STRING', value: w.oldSecret };
  const result = await run(w);
  const valueEdit = w.edits[0].fields.find((f) => f.id === 'credential')!;
  assert.equal(valueEdit.type, 'CONCEALED');
  assert.equal(valueEdit.value, w.secret);
  assert.equal(w.item.fields[0].type, 'CONCEALED', 'the item now masks the key');
  assert.deepEqual(result.warnings, []);
});

test('an item that stays plain text after the write is a warning, not a stop', async () => {
  const w = world();
  w.item.fields[0] = { id: 'credential', label: '', type: 'STRING', value: w.oldSecret };
  const edit = w.deps.op.editItem;
  w.deps.op.editItem = async (item, template) => {
    // This vault refuses the type change but takes the value.
    await edit(item, { fields: template.fields.map((f) => ({ ...f, type: f.id === 'credential' ? 'STRING' : f.type })) });
  };
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.ok(result.warnings.some((x) => x.includes('plain text')));
});

test('an empty built-in credential slot beside a filled custom field does not win', () => {
  // The layout Matt rebuilt by hand: custom Password, Date and text fields, and the built-in slot left empty.
  const item: OpItem = {
    fields: [
      { id: 'credential', label: '', type: 'STRING', value: undefined },
      { id: 'zk3m9q', label: 'Credential', type: 'CONCEALED', value: 'real' },
      { id: 'pj7x1c', label: 'expires', type: 'DATE', value: '1802000000' },
      { id: 'hs4w8d', label: 'key_id', type: 'STRING', value: 'abc' },
    ],
  };
  assert.equal(pickValueField(item)?.id, 'zk3m9q');
  assert.equal(pickValueField(item)?.value, 'real');
  assert.deepEqual(secretValues(item), ['real']);
  // The empty slot is still the answer when nothing else has a value.
  const empty: OpItem = { fields: [item.fields[0], { ...item.fields[1], value: undefined }] };
  assert.equal(pickValueField(empty)?.id, 'credential');
});

test('a custom field labelled password is found by label, in any case', () => {
  const item: OpItem = { fields: [{ id: 'k1', label: 'PASSWORD', type: 'CONCEALED', value: 'v' }, { id: 'k2', label: 'other', type: 'CONCEALED', value: 'w' }] };
  assert.equal(pickValueField(item)?.id, 'k1');
});

test('a rotation on the rebuilt layout reads and writes the custom field, not the empty slot', async () => {
  const w = world();
  w.item = {
    fields: [
      { id: 'credential', label: '', type: 'STRING', value: undefined },
      { id: 'zk3m9q', label: 'credential', type: 'CONCEALED', value: w.oldSecret },
      { id: 'pj7x1c', label: 'expires', type: 'STRING', value: '2026-12-01' },
      { id: 'hs4w8d', label: 'key_id', type: 'STRING', value: 'oldkey123' },
    ],
  };
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(w.item.fields[1].value, w.secret, 'the custom field holds the new value');
  assert.equal(w.item.fields[0].value, undefined, 'the empty slot stays empty');
  assert.deepEqual(w.railwaySets, [{ name: 'TEMPORAL_METRICS_API_KEY', value: w.secret }]);
});

test('pickValueField still reads a value field typed STRING', () => {
  const item: OpItem = { fields: [{ id: 'credential', label: '', type: 'STRING', value: 'v' }] };
  assert.equal(pickValueField(item)?.value, 'v');
});

test('a labelled key_id field with a random id keeps its label through the edit', async () => {
  const w = world();
  w.item = {
    fields: [
      { id: 'credential', label: '', type: 'STRING', value: w.oldSecret },
      { id: 'expires', label: '', type: 'STRING', value: '1790000000' },
      { id: 'wuxmu2a3okectjag2eu5fyid5u', label: 'key_id', type: 'STRING', value: 'oldkey123' },
    ],
  };
  const result = await run(w);
  assert.deepEqual(result.warnings, [], 'key_id reads back by its label');
  const entry = w.edits[0].fields.find((f) => f.id === 'wuxmu2a3okectjag2eu5fyid5u')!;
  assert.equal(entry.label, 'key_id', 'the template restates the label');
  assert.equal(entry.type, 'STRING');
  assert.equal(w.item.fields[2].label, 'key_id');
  assert.equal(w.item.fields[2].value, 'newkey456');
  const credential = w.edits[0].fields.find((f) => f.id === 'credential')!;
  assert.ok(!('label' in credential), 'a field with no label gets none added');
});

test('the credential field is masked from logs and stop messages whatever its type', async () => {
  const w = world();
  w.item.fields[0] = { id: 'credential', label: '', type: 'STRING', value: w.oldSecret };
  w.deps.op.editItem = async () => {
    throw new Error(`op echoed the item: ${w.oldSecret}`);
  };
  const err = await stoppedAt(run(w));
  assert.ok(!err.message.includes(w.oldSecret), 'the old value, held in a STRING field, is redacted');
  assert.deepEqual(secretValues(w.item), [w.oldSecret]);
});

test('fieldByLabel matches a label or an id, in either case', () => {
  const item: OpItem = {
    fields: [
      { id: 'expires', label: '', type: 'STRING', value: '1' },
      { id: 'abc', label: 'Key_ID', type: 'STRING', value: '2' },
    ],
  };
  assert.equal(fieldByLabel(item, 'expires')?.value, '1');
  assert.equal(fieldByLabel(item, 'EXPIRES')?.value, '1');
  assert.equal(fieldByLabel(item, 'key_id')?.value, '2');
  assert.equal(fieldByLabel(item, 'missing'), undefined);
});

test('an orphan deleted on a rerun is not taken for the old key, and retire asks which key to delete', async () => {
  const w = world({
    editFails: true,
    confirms: [true],
    keyList: [{ id: 'bRku-old' }, { id: 'Qupf-disabled' }, { id: 'newkey456' }],
    lines: ['1'],
  });
  w.item.fields.find((f) => f.label === 'key_id')!.value = 'newkey456';
  const first = await stoppedAt(run(w));
  assert.equal(first.step, 'store');
  assert.equal(w.states.get(metrics.name)?.orphanKeyId, 'newkey456');

  // The rerun deletes the orphan, issues a fresh key, and the item still names the orphan as key_id.
  w.editFails = false;
  w.confirms = [true, true];
  w.deps.tcld.createKey = async () => ({ keyId: 'fresh111', token: w.secret });
  const result = await run(w);
  assert.ok(w.deleted.includes('newkey456'), 'the orphan went');
  assert.equal(result.newKeyId, 'fresh111');
  assert.ok(w.deleted.includes('bRku-old'), 'Matt picked the real old key from the list');
  assert.equal(w.deleted.filter((id) => id === 'newkey456').length, 1, 'the orphan is not deleted a second time as the old key');
});

test('a recorded old key that has already left the list is not a failure', async () => {
  const w = world({ keyList: [] });
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.deepEqual(w.deleted, []);
  assert.ok(w.logs.some((l) => l.includes('no longer in the service account key list')));
});

test('a value that is stored but whose expires and key_id did not land warns, clears the orphan, and carries on', async () => {
  const w = world({ dropBookkeeping: true });
  const result = await run(w);
  assert.equal(result.completed, true, 'the rotation goes on to push, verify and retire');
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /reads expires as 2026-.*not 2027-/);
  assert.match(result.warnings[1], /key_id/);
  assert.deepEqual(w.railwaySets, [{ name: 'TEMPORAL_METRICS_API_KEY', value: w.secret }]);
  assert.ok(w.logs.some((l) => l.includes('WARNING')));
});

test('once the value reads back, the key is no longer an orphan, even if a later step fails', async () => {
  const w = world({ dropBookkeeping: true });
  const realSet = w.deps.railway.setVariable;
  w.deps.railway.setVariable = async () => {
    throw new Error('railway variable set exited 1');
  };
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'push');
  const saved = w.states.get(metrics.name)!;
  assert.equal(saved.orphanKeyId, undefined, 'the saved state no longer calls the key an orphan');
  assert.ok(saved.done.includes('store'));
  assert.equal(saved.newKeyId, 'newkey456');
  // A rerun does not offer to delete the key whose value sits in the item.
  w.deps.railway.setVariable = realSet;
  w.confirms = [true];
  await run(w);
  assert.ok(!w.deleted.includes('newkey456'));
  assert.equal(w.calls.filter((c) => c === 'tcld.create').length, 1);
});

test('a pasted value that fails its shape check stops the run before anything is stored', async () => {
  const w = world({ tcld: false, secrets: ['short'] });
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'issue');
  assert.ok(!w.calls.includes('op.edit'));
});

test('a pasted expiry that is not a date stops the run', async () => {
  const w = world({ tcld: false, secrets: [fresh('p_')], lines: ['', 'next spring'] });
  const err = await stoppedAt(run(w));
  assert.match(err.message, /YYYY-MM-DD/);
  assert.ok(!w.calls.includes('op.edit'));
});

test('healthcheck-base is pasted, verified with one /log ping, and has no retire', async () => {
  const base = `https://hc-ping.com/${fresh('')}`;
  const w = world({ secrets: [base] });
  w.item = { fields: [{ id: 'password', label: 'password', type: 'CONCEALED', value: 'old' }] };
  w.deps.verifiers['action-usage'] = async () => assert.fail('the sampler is not this credential check');
  w.logsByDeployment.set('dep-new-1', ['steward worker polling alerting: "configured"']);
  const result = await run(w, healthcheck);
  assert.equal(result.completed, true);
  assert.equal(result.retire, 'not-applicable');
  assert.ok(w.calls.includes('ping'));
  assert.ok(!w.calls.includes('tcld.create'));
  assert.deepEqual(w.railwaySets, [{ name: 'STEWARD_HEALTHCHECK_BASE', value: base }]);
  assert.deepEqual(w.envWrites, [{ key: 'STEWARD_HEALTHCHECK_BASE', value: base }]);
  assert.ok(!w.edits[0].fields.some((f) => f.label === 'expires'), 'a credential without an expiry writes none');
});

test('healthcheck-base rejects a ping base that is not a hc-ping.com URL', async () => {
  const w = world({ secrets: ['https://hc-ping.com/abc/'] });
  const err = await stoppedAt(run(w, healthcheck));
  assert.equal(err.step, 'issue');
  assert.match(err.message, /hc-ping\.com/);
});

test('--from-op skips issue and store and pushes what the item already holds', async () => {
  const w = world();
  w.item.fields[0].value = w.secret;
  const result = await run(w, metrics, { fromOp: true });
  assert.ok(!w.calls.includes('tcld.create'));
  assert.ok(!w.calls.includes('op.edit'));
  assert.deepEqual(w.railwaySets, [{ name: 'TEMPORAL_METRICS_API_KEY', value: w.secret }]);
  assert.equal(result.newKeyId, undefined);
});

test('preflight problems stop the run before any call that changes anything', async () => {
  const w = world({ problems: ['railway is not on PATH.'] });
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'preflight');
  assert.match(err.message, /railway is not on PATH/);
  assert.deepEqual(w.calls, ['preflight']);
});

test('a bad --duration stops before preflight', async () => {
  const w = world();
  const err = await stoppedAt(run(w, metrics, { duration: 'soon' }));
  assert.equal(err.step, 'preflight');
  assert.deepEqual(w.calls, []);
});

test('a refused 1Password edit leaves the issued key as an orphan, and a rerun offers to delete it', async () => {
  const w = world({ editFails: true, confirms: [true] });
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'store');
  assert.equal(w.states.get(metrics.name)?.orphanKeyId, 'newkey456');
  assert.ok(!w.calls.includes('railway.set'), 'nothing was pushed');

  w.editFails = false;
  const result = await run(w);
  assert.ok(w.deleted.includes('newkey456'), 'the orphan is deleted after the yes');
  assert.equal(w.calls.filter((c) => c === 'tcld.create').length, 2, 'a fresh key is issued after the orphan goes');
  assert.equal(result.completed, false, 'the confirm list ran out, so the old key stays');
});

test('a create whose output cannot be read still records the key tcld made, and the rerun offers to delete it', async () => {
  const w = world({
    keyList: [
      { id: 'earlier-key', created: '2026-11-09T05:29:01Z' },
      { id: 'newkey456', created: '2026-10-21T23:02:02Z' },
    ],
    confirms: [true],
  });
  // tcld creates the key, then its output fails to parse: the run never sees a key id or a secret.
  w.deps.tcld.createKey = async () => {
    w.calls.push('tcld.create');
    w.keyList.push({ id: 'orphan789', created: PUSHED });
    throw new Error('tcld printed no key id and token in the shape this command expects');
  };
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'issue');
  assert.match(err.message, /no key id and token/);
  assert.equal(w.states.get(metrics.name)?.orphanKeyId, 'orphan789', 'only the key made during the step is recorded');
  assert.ok(w.logs.some((l) => l.includes('orphan789') && l.includes('not captured')));

  // The rerun asks, deletes the orphan after the yes, and issues a fresh key.
  w.deps.tcld.createKey = async () => ({ keyId: 'fresh111', token: w.secret });
  w.confirms = [true, true];
  const result = await run(w);
  assert.ok(w.deleted.includes('orphan789'));
  assert.equal(result.newKeyId, 'fresh111');
});

test('a failed create that made no key records no orphan', async () => {
  const w = world({ keyList: [{ id: 'earlier-key', created: '2026-11-09T05:29:01Z' }] });
  w.deps.tcld.createKey = async () => {
    throw new Error('tcld: not logged in');
  };
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'issue');
  assert.equal(w.states.get(metrics.name)?.orphanKeyId, undefined);
});

test('a rerun with an orphan and a no stops without issuing', async () => {
  const w = world({ editFails: true, confirms: [false] });
  await stoppedAt(run(w));
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'issue');
  assert.match(err.message, /Delete key newkey456/);
  assert.equal(w.calls.filter((c) => c === 'tcld.create').length, 1);
});

test('a 1Password edit that does not read back as the new value stops the run before the push', async () => {
  const w = world({ corruptEdit: true });
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'store');
  assert.match(err.message, /does not hold the new value/);
  assert.ok(!w.calls.includes('railway.set'));
});

test('an item with no usable value field stops the run with a message that names the item', async () => {
  const w = world();
  w.item = { fields: [{ id: 'a', label: 'a', type: 'CONCEALED', value: '1' }, { id: 'b', label: 'b', type: 'CONCEALED', value: '2' }] };
  const err = await stoppedAt(run(w));
  assert.match(err.message, /TEMPORAL_METRICS_API_KEY/);
});

test('a failed push stops before the env step, and a rerun resumes at the push without a second key', async () => {
  const w = world();
  let fail = true;
  const set = w.deps.railway.setVariable;
  w.deps.railway.setVariable = async (n, v) => {
    if (fail) throw new Error('railway variable set exited 1');
    await set(n, v);
  };
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'push');
  assert.deepEqual(err.remaining, ['push', 'env', 'wait', 'verify', 'retire']);
  assert.ok(!w.calls.includes('env.set'));

  fail = false;
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.equal(w.calls.filter((c) => c === 'tcld.create').length, 1);
  assert.equal(w.calls.filter((c) => c === 'op.edit').length, 1);
  assert.ok(w.logs.some((l) => l.includes('Resuming temporal-metrics')));
});

test('the env step failing leaves the push done, and the rerun does the env step alone', async () => {
  const w = world();
  let fail = true;
  const set = w.deps.env.setLine;
  w.deps.env.setLine = async (k, v) => {
    if (fail) throw new Error('EBUSY: resource busy');
    await set(k, v);
  };
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'env');
  fail = false;
  await run(w);
  assert.equal(w.railwaySets.length, 1, 'the variable is set once');
  assert.deepEqual(w.envWrites.length, 1);
});

test('a reference line in .env is kept, and the step says the 1Password item is the local copy', async () => {
  const w = world();
  w.deps.env.setLine = async () => 'kept-reference';
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.ok(w.logs.some((l) => /is a 1Password reference/.test(l) && /nothing was written/.test(l)));
  assert.ok(!w.logs.some((l) => /rewrote the .* line/.test(l)));
});

test('wait stops when no new deployment appears', async () => {
  const w = world({ newDeploymentOnPush: false });
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'wait');
  assert.match(err.message, /No new Railway deployment/);
  assert.ok(!w.calls.includes('sample'));
});

test('wait ignores the deployment that existed before the push', async () => {
  const w = world({ newDeploymentOnPush: false });
  w.logsByDeployment.set('dep-old', ['steward worker polling actionUsage: "configured"']);
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'wait');
});

test('wait stops on a failed deployment and names it', async () => {
  const w = world({ newDeploymentOnPush: false });
  const set = w.deps.railway.setVariable;
  w.deps.railway.setVariable = async (n, v) => {
    await set(n, v);
    w.deployments.unshift({ id: 'dep-bad', status: 'FAILED', createdAt: '2026-11-09T06:00:09.000Z' });
  };
  const err = await stoppedAt(run(w));
  assert.match(err.message, /dep-bad ended FAILED/);
});

test('wait stops when the ready line does not say the variable is configured', async () => {
  const w = world();
  w.deps.railway.setVariable = async (n, v) => {
    w.railwaySets.push({ name: n, value: v });
    w.deployments.unshift({ id: 'dep-off', status: 'SUCCESS', createdAt: '2026-11-09T06:00:05.000Z' });
    w.logsByDeployment.set('dep-off', ['steward worker polling actionUsage: "OFF"']);
  };
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'wait');
  assert.match(err.message, /actionUsage: configured/);
  assert.ok(!w.calls.includes('sample'), 'verify does not run on a worker that lacks the variable');
});

test('verify retries a key that answers Access Denied at first, then passes', async () => {
  const w = world({ samplerFailures: 2 });
  const result = await run(w);
  assert.equal(result.completed, true);
  assert.equal(w.calls.filter((c) => c === 'sample').length, 3);
  assert.ok(w.logs.some((l) => l.includes('not yet') && l.includes('403')));
});

test('verify gives up after its window, leaves retire undone, and never deletes the old key', async () => {
  const w = world({ samplerFailures: 1000 });
  const err = await stoppedAt(run(w));
  assert.equal(err.step, 'verify');
  assert.match(err.message, /403/);
  assert.deepEqual(w.deleted, []);
  assert.deepEqual(err.remaining, ['verify', 'retire']);
  assert.ok(!w.calls.some((c) => c.startsWith('confirm:')), 'Matt is not asked to delete anything yet');
});

test('a failed healthcheck ping stops the run at verify', async () => {
  const w = world({ secrets: [`https://hc-ping.com/${fresh('')}`], pingFailures: 1000 });
  w.item = { fields: [{ id: 'password', label: 'password', type: 'CONCEALED', value: 'old' }] };
  w.logsByDeployment.set('dep-new-1', ['steward worker polling alerting: "configured"']);
  const err = await stoppedAt(run(w, healthcheck));
  assert.equal(err.step, 'verify');
});

test('--restart discards stored progress', async () => {
  const w = world({ confirms: [false] });
  await run(w);
  assert.equal(w.states.size, 1);
  w.confirms = [true];
  await run(w, metrics, { restart: true });
  assert.equal(w.calls.filter((c) => c === 'tcld.create').length, 2, 'a restart issues a new key');
});

/* ---------------- pure helpers ---------------- */

test('durationDays reads the forms tcld takes', () => {
  assert.equal(durationDays('90d'), 90);
  assert.equal(durationDays('4d12h'), 5);
  assert.equal(durationDays('1.5y'), 548);
  assert.equal(durationDays('2w'), 14);
  assert.equal(durationDays('soon'), null);
  assert.equal(durationDays('90'), null);
  assert.equal(durationDays(''), null);
});

test('redactSecrets masks the longest value first and ignores short ones', () => {
  const long = fresh('abc');
  const nested = `${long}-tail`;
  assert.equal(redactSecrets(`x ${nested} y`, [long, nested]), 'x [REDACTED] y');
  assert.equal(redactSecrets('a b c', ['a']), 'a b c');
});

test('pickValueField prefers credential, then password, then the one concealed field', () => {
  const f = (id: string, type = 'STRING'): OpField => ({ id, label: id, type, value: 'v' });
  assert.equal(pickValueField({ fields: [f('notes'), f('credential', 'CONCEALED')] })?.id, 'credential');
  assert.equal(pickValueField({ fields: [f('password', 'CONCEALED'), f('x', 'CONCEALED')] })?.id, 'password');
  assert.equal(pickValueField({ fields: [f('only', 'CONCEALED'), f('t')] })?.id, 'only');
  assert.equal(pickValueField({ fields: [f('a', 'CONCEALED'), f('b', 'CONCEALED')] }), null);
});

test('expires values follow the form the item already uses', () => {
  const epoch: OpField = { id: 'e', label: 'expires', type: 'DATE', value: '1790000000' };
  assert.equal(expiresValueFor(epoch, '2027-02-01'), String(Date.parse('2027-02-01T12:00:00Z') / 1000));
  assert.equal(expiresValueFor({ ...epoch, value: '2026-01-01' }, '2027-02-01'), '2027-02-01');
  assert.equal(expiresValueFor(undefined, '2027-02-01'), '2027-02-01');
  assert.equal(expiresAsIso(String(Date.parse('2027-02-01T12:00:00Z') / 1000)), '2027-02-01');
  assert.equal(expiresAsIso('2027-02-01'), '2027-02-01');
  assert.equal(expiresAsIso(undefined), null);
});

test('buildTemplate creates the expires and key_id fields by label when the item lacks them', () => {
  const item: OpItem = { fields: [{ id: 'credential', label: 'credential', type: 'CONCEALED', value: 'x' }] };
  const t = buildTemplate({ item, valueField: item.fields[0], value: 'v', keyId: 'k', expires: '2027-02-01' });
  assert.deepEqual(t.fields, [
    { id: 'credential', label: 'credential', type: 'CONCEALED', value: 'v' },
    { label: 'expires', type: 'STRING', value: '2027-02-01' },
    { label: 'key_id', type: 'STRING', value: 'k' },
  ]);
});


test('readyLineSays reads the worker\'s JSON line and a terminal line alike', () => {
  assert.ok(readyLineSays('{"actionUsage":"configured","alerting":"OFF"}', 'actionUsage', 'configured'));
  assert.ok(readyLineSays('steward worker polling actionUsage: "configured"', 'actionUsage', 'configured'));
  assert.ok(readyLineSays('actionUsage: configured', 'actionUsage', 'configured'));
  assert.ok(!readyLineSays('actionUsage: "OFF"', 'actionUsage', 'configured'));
  assert.ok(!readyLineSays('alerting: "configured"', 'actionUsage', 'configured'));
  assert.ok(!readyLineSays('actionUsage: "configured_not"', 'actionUsage', 'configured'));
});

test('the credential table has one row per credential, with every column filled', () => {
  for (const spec of Object.values(CREDENTIALS)) {
    for (const key of ['name', 'envVar', 'opItem', 'railwayVariable', 'issuer', 'verify', 'readyField', 'readyValue'] as const) {
      assert.ok(spec[key], `${spec.name} has ${key}`);
    }
    assert.equal(spec.envVar, spec.railwayVariable, 'the .env name and the Railway name agree');
  }
  assert.deepEqual(Object.keys(CREDENTIALS), ['temporal-metrics', 'healthcheck-base']);
});
