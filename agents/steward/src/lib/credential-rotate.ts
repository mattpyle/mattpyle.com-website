/**
 * The generic credential-rotation runner behind `steward credential rotate
 * <name>`: it takes one credential through issue, store, push, env, wait, verify
 * and retire. It names nothing of Steward's: a credential is a row
 * ({@link CredentialSpec}) and the place it lives is a {@link RotateTarget}, both
 * supplied by `credentials.ts`, so the same runner can rotate another repository's
 * keys later.
 *
 * ## Why one command
 *
 * A rotation copies one new value into several systems by hand, and the copy
 * most likely to be missed (the second one, on the host) is the one that stops
 * the service. The command does every copy, reads the service's ready line after
 * the redeploy, proves the new value works, and only then offers to delete the
 * old key.
 *
 * ## Where it runs
 *
 * On Matt's machine only. `tcld login` and the 1Password approval are
 * interactive, and no hosted path exists. This file decides; every call that
 * leaves the process (`tcld`, `op`, `railway`, the GraphQL endpoint, fetch, the
 * file system, the prompt, the verify function) goes through {@link RotateDeps},
 * so the tests run each step against fakes. `credential-rotate-deps.ts` wires the
 * real calls.
 *
 * ## The steps
 *
 * 1. `issue`: `tcld apikey create` for a credential whose issuer has an API, or
 *    a pasted value from a hidden prompt when `tcld` is absent or the issuer has
 *    no API (healthchecks.io).
 * 2. `store`: the value, the expiry and the issuer's key id go into the
 *    credential's 1Password item, and the command reads the item back.
 * 3. `push`: `railway variable set` over stdin. The redeploy is the point, so
 *    the call does not skip it.
 * 4. `env`: one line of the credential's `.env` file is rewritten in place.
 * 5. `wait`: the new Railway deployment, then its log for the ready line.
 * 6. `verify`: the thing the ready line cannot say, that the value works. The
 *    row names a verify function; the caller supplies it.
 * 7. `retire`: the old key is deleted at the issuer, after Matt confirms.
 *
 * ## Secrets
 *
 * A secret never appears in argv or a log line. It reaches `op` and `railway`
 * over stdin, and every message the command prints passes through
 * {@link redactSecrets}. After `store` the command holds the value only for the
 * length of one step and reads it back from 1Password the next time it needs it.
 *
 * ## Resume
 *
 * Each completed step is written to a state file in the `.cache/` folder beside
 * the `.env` file (gitignored). The file holds key ids, a deployment id and
 * dates, and never a secret value. The command stops at the first failure, says
 * what remains, and a rerun skips the completed steps. One gap cannot resume: a
 * key issued but not yet stored. The state records that key's id as an orphan,
 * and the rerun offers to delete it.
 */

export const ROTATE_STEPS = ['issue', 'store', 'push', 'env', 'wait', 'verify', 'retire'] as const;
export type RotateStep = (typeof ROTATE_STEPS)[number];

/** Where a credential lives: the host service that reads it and the vault that holds it. */
export interface RotateTarget {
  /** The Railway project the CLI must be linked to. A different link stops the run. */
  railwayProject: string;
  railwayService: string;
  railwayEnvironment: string;
  /** The 1Password vault that holds one item per variable. */
  opVault: string;
  /** The text of the service's ready log line, which carries the facts the row checks. */
  readyMarker: string;
}

export interface CredentialSpec {
  /** The name on the command line. */
  name: string;
  /** The variable in the `.env` file. */
  envVar: string;
  /** The 1Password item title. */
  opItem: string;
  /** The variable on the Railway service. */
  railwayVariable: string;
  /** Who issues it. `tcld` has an API; `manual` is a console with none. */
  issuer: 'tcld' | 'manual';
  /** For `tcld`: the name of the service account that owns the key. */
  serviceAccount?: string;
  /** For `tcld`: the key's display name in Cloud. */
  keyDisplayName?: string;
  /** What the person pastes, in the prompt text. */
  pasteLabel: string;
  /** The Cloud or console steps printed when the command takes a pasted value. */
  manualSteps: string[];
  /** Whether the credential has an expiry date that 1Password tracks. */
  dated: boolean;
  /** The key of the verify function the caller supplies in {@link RotateDeps.verifiers}. */
  verify: string;
  /** The plan line for the verify step, after "verify: ". */
  verifyPlan: string;
  /** The log line when verify passes. */
  verifyDone: string;
  /** The ready-line field and value that say the service holds the variable. */
  readyField: string;
  readyValue: string;
  /** A shape check on a pasted value. Returns a complaint, or null when it is fine. */
  checkValue(value: string): string | null;
}

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

/** Everything a rerun needs, and no secret. */
export interface RotateState {
  version: 1;
  credential: string;
  startedAt: string;
  done: RotateStep[];
  duration: string;
  /** The new key's id at the issuer, when known. */
  newKeyId?: string;
  /** The key being replaced, read from the item's `key_id` field before the store. */
  oldKeyId?: string;
  /** A key issued but not yet stored. The rerun offers to delete it. */
  orphanKeyId?: string;
  /** Orphans this command deleted. The item may still name one as its `key_id`, and it is not the old key. */
  deletedKeyIds?: string[];
  /** YYYY-MM-DD. */
  expires?: string;
  /** The latest Railway deployment before the push. */
  priorDeploymentId?: string;
  pushedAt?: string;
  deploymentId?: string;
  /** Set when retire ended without a delete, with the reason. */
  retireNote?: string;
}

export interface OpField {
  id: string;
  label: string;
  type: string;
  purpose?: string;
  value?: string;
}
export interface OpItem {
  fields: OpField[];
}

export interface TcldKey {
  keyId: string;
  token: string;
  expires?: string;
}
export interface TcldListedKey {
  id: string;
  name?: string;
  expires?: string;
  disabled?: boolean;
  /** When the issuer created it, RFC 3339. */
  created?: string;
}

export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
}

export interface RotateDeps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** Today in the operator's zone, YYYY-MM-DD, plus the given days. */
  isoDatePlus(from: Date, days: number): string;
  prompt: {
    secret(label: string): Promise<string>;
    line(label: string, fallback?: string): Promise<string>;
    confirm(label: string): Promise<boolean>;
  };
  state: {
    load(name: string): Promise<RotateState | null>;
    save(name: string, state: RotateState): Promise<void>;
    clear(name: string): Promise<void>;
  };
  /** Pure file-system checks, safe in a dry run. */
  hasTcld(): boolean;
  /** Checks the tools, the Railway link and the env file. Returns what is wrong. */
  preflight(): Promise<string[]>;
  tcld: {
    resolveServiceAccount(name: string): Promise<string>;
    createKey(args: { serviceAccountId: string; name: string; description: string; duration: string }): Promise<TcldKey>;
    listKeys(serviceAccountId: string): Promise<TcldListedKey[]>;
    /** Asks the issuer to delete the key. Returns the request state it answered, for example `Pending`. */
    deleteKey(keyId: string): Promise<string | undefined>;
  };
  op: {
    readItem(item: string): Promise<OpItem>;
    /** Edits the item from a JSON template piped over stdin. */
    editItem(item: string, template: { fields: Array<Record<string, unknown>> }): Promise<void>;
  };
  railway: {
    latestDeploymentId(): Promise<string | null>;
    /** Sets the variable over stdin, with a redeploy. */
    setVariable(name: string, value: string): Promise<void>;
    deployments(): Promise<RailwayDeployment[]>;
    logs(deploymentId: string): Promise<string[]>;
  };
  env: {
    path: string;
    setLine(key: string, value: string): Promise<void>;
  };
  /**
   * The verify functions, by the key a row names in `verify`. One takes the new
   * value, returns when it works and throws when it does not.
   */
  verifiers: Record<string, (value: string) => Promise<void>>;
}

export interface RotateOptions {
  duration: string;
  dryRun: boolean;
  /** The new value is already in 1Password: skip issue and store. */
  fromOp: boolean;
  /** Discard a stored state and start again. */
  restart: boolean;
  /** Overrides the service account lookup by name. */
  serviceAccountId?: string;
}

/** Timings. A test passes small ones. */
export interface RotateTimings {
  deployPollMs: number;
  deployTimeoutMs: number;
  readyTimeoutMs: number;
  verifyTimeoutMs: number;
  verifyFirstDelayMs: number;
  verifyMaxDelayMs: number;
  /** How long retire watches for the deleted key to leave the issuer's list, and how often it looks. */
  deleteTimeoutMs: number;
  deletePollMs: number;
}
export const DEFAULT_TIMINGS: RotateTimings = {
  deployPollMs: 10_000,
  deployTimeoutMs: 15 * 60_000,
  readyTimeoutMs: 3 * 60_000,
  verifyTimeoutMs: 2 * 60_000,
  verifyFirstDelayMs: 5_000,
  verifyMaxDelayMs: 20_000,
  deleteTimeoutMs: 60_000,
  deletePollMs: 5_000,
};

/** Thrown at the first failure. The CLI prints it and exits 1. */
export class RotateStopped extends Error {
  readonly name = 'RotateStopped';
  constructor(
    readonly step: RotateStep | 'preflight',
    message: string,
    readonly remaining: RotateStep[],
  ) {
    super(message);
  }
}

export interface RotateResult {
  completed: boolean;
  deploymentId?: string;
  newKeyId?: string;
  expires?: string;
  /** Bookkeeping that did not land, for Matt to fix by hand. The value itself is stored. */
  warnings: string[];
  /** What retire did: deleted, left to Matt, declined, or not applicable. */
  retire: 'deleted' | 'manual' | 'declined' | 'not-applicable' | 'pending';
  remaining: RotateStep[];
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                         */
/* ------------------------------------------------------------------ */

const DURATION_PATTERN = /^(\d+(\.\d+)?[ywdh])+$/;

/** `90d`, `4d12h` and `1.5y` as whole days, rounded up. Null for anything else. */
export function durationDays(duration: string): number | null {
  if (!DURATION_PATTERN.test(duration)) return null;
  let hours = 0;
  for (const m of duration.matchAll(/(\d+(?:\.\d+)?)([ywdh])/g)) {
    const n = Number(m[1]);
    hours += n * { y: 365 * 24, w: 7 * 24, d: 24, h: 1 }[m[2] as 'y' | 'w' | 'd' | 'h'];
  }
  return Math.ceil(hours / 24);
}

/** Replaces every secret in `text` with a marker, longest first. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].filter((s) => s.length >= 6).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/** The 1Password field that holds the value: the credential field, the password, or the one concealed field. */
export function pickValueField(item: OpItem): OpField | null {
  const byId = item.fields.find((f) => f.id === 'credential' || f.id === 'password');
  if (byId) return byId;
  const concealed = item.fields.filter((f) => f.type === 'CONCEALED');
  return concealed.length === 1 ? concealed[0] : null;
}

/**
 * A field by its label or its id, case-insensitive. 1Password's built-in fields
 * (`expires` on an API credential) have an id and no label, and a field Matt added
 * has a label and a random id, so either may name the one wanted.
 */
export function fieldByLabel(item: OpItem, name: string): OpField | undefined {
  const wanted = name.toLowerCase();
  return item.fields.find((f) => f.label.toLowerCase() === wanted || f.id.toLowerCase() === wanted);
}

/**
 * Every value in the item that must never reach a log: concealed fields, and the
 * `credential` or `password` field whatever its type (an API credential item holds
 * its key in a plain STRING field).
 */
export function secretValues(item: OpItem): string[] {
  return item.fields
    .filter((f) => f.value && (f.type === 'CONCEALED' || f.id === 'credential' || f.id === 'password'))
    .map((f) => f.value!);
}

/**
 * The expiry in the form the item already uses: epoch seconds when the existing
 * value is a long run of digits, otherwise an ISO date. The store step reads the
 * item back, so a form the vault rejects fails there, not silently.
 */
export function expiresValueFor(existing: OpField | undefined, isoDate: string): string {
  if (existing?.value && /^\d{9,}$/.test(existing.value)) {
    return String(Math.floor(Date.parse(`${isoDate}T12:00:00Z`) / 1000));
  }
  return isoDate;
}

/** Reads an item's expiry back to YYYY-MM-DD, whichever form the vault stored. */
export function expiresAsIso(value: string | undefined): string | null {
  if (!value) return null;
  if (/^\d{9,}$/.test(value)) return new Date(Number(value) * 1000).toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

/**
 * The JSON template `op item edit` takes on stdin. Fields are named by id when
 * the item has them and by label when it does not (1Password then creates one).
 */
export function buildTemplate(args: {
  item: OpItem;
  valueField: OpField;
  value: string;
  keyId?: string;
  expires?: string;
}): { fields: Array<Record<string, unknown>> } {
  // CONCEALED, so the value is masked in the app and in `op item get`. An item made before this
  // rotation may hold the key in a plain STRING field; the write converts it.
  const fields: Array<Record<string, unknown>> = [{ id: args.valueField.id, type: 'CONCEALED', value: args.value }];
  if (args.expires) {
    const existing = fieldByLabel(args.item, 'expires');
    const value = expiresValueFor(existing, args.expires);
    fields.push(existing ? { id: existing.id, value } : { label: 'expires', type: 'STRING', value });
  }
  if (args.keyId) {
    const existing = fieldByLabel(args.item, 'key_id');
    fields.push(existing ? { id: existing.id, value: args.keyId } : { label: 'key_id', type: 'STRING', value: args.keyId });
  }
  return { fields };
}

/** The ready-line check. The hosted worker logs JSON; a terminal logs `field: value`. */
export function readyLineSays(line: string, field: string, value: string): boolean {
  return new RegExp(`${field}"?\\s*[:=]\\s*"?${value}\\b`).test(line);
}

const FAILED_DEPLOYMENT = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

/* ------------------------------------------------------------------ */
/* The command                                                          */
/* ------------------------------------------------------------------ */

/** The plan, one line per step, for `--dry-run`. Makes no call. */
export function describePlan(
  spec: CredentialSpec,
  target: RotateTarget,
  options: RotateOptions,
  hasTcld: boolean,
  envPath: string,
): string[] {
  const viaTcld = spec.issuer === 'tcld' && hasTcld && !options.fromOp;
  const lines: string[] = [];
  if (options.fromOp) {
    lines.push(`1. issue: skipped (--from-op). The new value is already in the 1Password item "${spec.opItem}".`);
    lines.push('2. store: skipped (--from-op).');
  } else if (viaTcld) {
    lines.push(
      `1. issue: tcld apikey create for the ${spec.serviceAccount} service account, duration ${options.duration}.`,
    );
    lines.push(`2. store: write the value, expires and key_id into the 1Password item "${spec.opItem}" and read it back.`);
  } else {
    const why = spec.issuer === 'manual' ? 'this issuer has no API' : 'tcld is not on PATH';
    lines.push(`1. issue: print the console steps (${why}) and take ${spec.pasteLabel} from a hidden prompt.`);
    lines.push(`2. store: write the value${spec.dated ? ', expires and key_id' : ''} into the 1Password item "${spec.opItem}" and read it back.`);
  }
  lines.push(`3. push: railway variable set ${spec.railwayVariable} --stdin on ${target.railwayService}/${target.railwayEnvironment}, which redeploys.`);
  lines.push(`4. env: rewrite the ${spec.envVar} line in ${envPath}.`);
  lines.push(`5. wait: the new deployment, then its log for the ready line with ${spec.readyField}: ${spec.readyValue}.`);
  lines.push(`6. verify: ${spec.verifyPlan}`);
  lines.push(
    spec.issuer === 'tcld'
      ? viaTcld
        ? '7. retire: delete the old key with tcld apikey delete, after you confirm.'
        : '7. retire: print the Cloud steps to delete the old key. tcld is absent, so you delete it.'
      : '7. retire: nothing to delete. Regenerating the value at the issuer already ended the old one.',
  );
  return lines;
}

export async function rotateCredential(
  spec: CredentialSpec,
  target: RotateTarget,
  options: RotateOptions,
  deps: RotateDeps,
  timings: RotateTimings = DEFAULT_TIMINGS,
): Promise<RotateResult> {
  const days = durationDays(options.duration);
  if (days === null) {
    throw new RotateStopped('preflight', `--duration ${options.duration} is not a duration. Use forms like 90d or 4d12h.`, [...ROTATE_STEPS]);
  }

  if (options.dryRun) {
    deps.log(`Plan for ${spec.name} (dry run, no call is made):`);
    for (const line of describePlan(spec, target, options, deps.hasTcld(), deps.env.path)) deps.log(`  ${line}`);
    return { completed: false, retire: 'pending', remaining: [...ROTATE_STEPS], warnings: [] };
  }

  const secrets: string[] = [];
  const say = (step: RotateStep, text: string) => deps.log(`  ${step.padEnd(6)} ${redactSecrets(text, secrets)}`);

  const problems = await deps.preflight();
  if (problems.length > 0) {
    throw new RotateStopped('preflight', `Cannot start:\n${problems.map((p) => `  - ${p}`).join('\n')}`, [...ROTATE_STEPS]);
  }

  if (options.restart) await deps.state.clear(spec.name);
  let state = await deps.state.load(spec.name);
  if (state) {
    const left = ROTATE_STEPS.filter((s) => !state!.done.includes(s));
    deps.log(`Resuming ${spec.name} from ${state.startedAt}. Done: ${state.done.join(', ') || 'nothing'}. Left: ${left.join(', ')}.`);
  } else {
    state = { version: 1, credential: spec.name, startedAt: deps.now().toISOString(), done: [], duration: options.duration };
  }
  const st = state;
  const isDone = (s: RotateStep) => st.done.includes(s);
  const remaining = () => ROTATE_STEPS.filter((s) => !st.done.includes(s));
  const finish = async (s: RotateStep) => {
    if (!st.done.includes(s)) st.done.push(s);
    await deps.state.save(spec.name, st);
  };
  const stop = (step: RotateStep, err: unknown): never => {
    const raw = err instanceof Error ? err.message : String(err);
    throw new RotateStopped(step, redactSecrets(raw, secrets), remaining());
  };
  const hasTcld = deps.hasTcld();
  let retire: RotateResult['retire'] = 'pending';
  const warnings: string[] = [];
  const warn = (text: string) => {
    warnings.push(text);
    say('store', `WARNING: ${text}`);
  };

  // An earlier run issued a key and died before it stored the value.
  if (st.orphanKeyId && !isDone('store')) {
    deps.log(`An earlier run issued key ${st.orphanKeyId} and did not store it. Nothing holds its value.`);
    if (spec.issuer === 'tcld' && hasTcld) {
      if (await deps.prompt.confirm(`Delete the orphan key ${st.orphanKeyId} now?`)) {
        try {
          await deps.tcld.deleteKey(st.orphanKeyId);
        } catch (err) {
          stop('issue', err);
        }
        st.deletedKeyIds = [...(st.deletedKeyIds ?? []), st.orphanKeyId];
        st.orphanKeyId = undefined;
        await deps.state.save(spec.name, st);
      } else {
        stop('issue', new Error(`Delete key ${st.orphanKeyId} at the issuer, then rerun.`));
      }
    } else {
      stop('issue', new Error(`Delete key ${st.orphanKeyId} in Temporal Cloud, then rerun with --restart.`));
    }
  }

  // 1 and 2: issue and store, which resume as one unit.
  if (!isDone('store')) {
    let value: string | null = null;
    let keyId: string | undefined;
    let expires: string | undefined;

    if (options.fromOp) {
      say('issue', `skipped: the new value is already in the 1Password item "${spec.opItem}" (--from-op)`);
    } else if (spec.issuer === 'tcld' && hasTcld) {
      const issueStartedAt = deps.now().getTime();
      let saId: string | undefined;
      try {
        saId = options.serviceAccountId ?? (await deps.tcld.resolveServiceAccount(spec.serviceAccount!));
        say('issue', `creating a ${options.duration} key for service account ${saId}`);
        const made = await deps.tcld.createKey({
          serviceAccountId: saId,
          name: spec.keyDisplayName ?? spec.name,
          description: `Rotated by credential rotate on ${deps.isoDatePlus(deps.now(), 0)}`,
          duration: options.duration,
        });
        secrets.push(made.token);
        value = made.token;
        keyId = made.keyId;
        expires = made.expires ?? deps.isoDatePlus(deps.now(), days);
        st.orphanKeyId = keyId;
        await deps.state.save(spec.name, st);
        say('issue', `issued key ${keyId}, expires ${expires}`);
      } catch (err) {
        // tcld may have created a key whose secret this run never saw (an output it could not read).
        // Record any key made since this step began, so the rerun offers to delete it.
        if (saId) {
          try {
            const made = (await deps.tcld.listKeys(saId))
              .filter((k) => k.created !== undefined && Date.parse(k.created) >= issueStartedAt - 60_000)
              .sort((a, b) => Date.parse(b.created!) - Date.parse(a.created!));
            if (made.length > 0 && made[0].id !== st.newKeyId) {
              st.orphanKeyId = made[0].id;
              await deps.state.save(spec.name, st);
              say('issue', `key ${made[0].id} was created and its value was not captured; the rerun offers to delete it`);
            }
          } catch {
            /* The original error is the one to report. */
          }
        }
        stop('issue', err);
      }
    } else {
      deps.log('');
      const why = spec.issuer === 'manual' ? 'This issuer has no API.' : 'tcld is not on PATH.';
      deps.log(`  ${why} Do these steps, then paste the value:`);
      spec.manualSteps.forEach((step, i) => deps.log(`    ${i + 1}. ${step}`));
      deps.log('');
      try {
        value = (await deps.prompt.secret(`Paste ${spec.pasteLabel}`)).trim();
        const complaint = spec.checkValue(value);
        if (complaint) throw new Error(`The pasted value is not usable: ${complaint}.`);
        secrets.push(value);
        if (spec.dated) {
          keyId = (await deps.prompt.line('Key id shown beside the key (Enter to skip)', '')).trim() || undefined;
          const entered = (await deps.prompt.line('Expiry date, YYYY-MM-DD', deps.isoDatePlus(deps.now(), days))).trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(entered)) throw new Error(`"${entered}" is not a YYYY-MM-DD date.`);
          expires = entered;
        }
      } catch (err) {
        stop('issue', err);
      }
      say('issue', `took ${spec.pasteLabel}${expires ? `, expires ${expires}` : ''}`);
    }

    if (options.fromOp) {
      say('store', 'skipped (--from-op)');
    } else {
      let back: OpItem | undefined;
      let concealedAfter = true;
      try {
        const item = await deps.op.readItem(spec.opItem);
        secrets.push(...secretValues(item));
        const valueField = pickValueField(item);
        if (!valueField) {
          throw new Error(`The 1Password item "${spec.opItem}" has no credential or password field, and not exactly one concealed field.`);
        }
        if (!st.oldKeyId) {
          const old = fieldByLabel(item, 'key_id')?.value?.trim();
          if (old && old !== keyId && !st.deletedKeyIds?.includes(old)) st.oldKeyId = old;
        }
        await deps.op.editItem(spec.opItem, buildTemplate({ item, valueField, value: value!, keyId, expires }));
        back = await deps.op.readItem(spec.opItem);
        const backField = pickValueField(back);
        if (backField?.value !== value) throw new Error(`The 1Password item "${spec.opItem}" does not hold the new value after the edit.`);
        concealedAfter = backField.type === 'CONCEALED';
      } catch (err) {
        stop('store', err);
      }
      // The value is safe in 1Password from here. The key is no longer an orphan, and the step is done
      // before the bookkeeping fields are checked: a wrong date is a warning for Matt, not a reason to stop.
      st.newKeyId = keyId;
      st.expires = expires;
      st.orphanKeyId = undefined;
      await finish('issue');
      await finish('store');
      say('store', `wrote ${spec.opItem} in the ${target.opVault} vault and read it back${st.oldKeyId ? `; old key id ${st.oldKeyId}` : ''}`);
      if (!concealedAfter) {
        warn(`the item's ${pickValueField(back!)?.id} field is still plain text, not concealed. Set its type to Password in the 1Password app.`);
      }
      if (expires) {
        const readBack = expiresAsIso(fieldByLabel(back!, 'expires')?.value);
        if (readBack !== expires) {
          warn(`the item reads expires as ${readBack ?? 'empty'}, not ${expires}. Set it in the 1Password app.`);
        }
      }
      if (keyId) {
        const readBack = fieldByLabel(back!, 'key_id')?.value?.trim();
        if (readBack !== keyId) {
          warn(`the item reads key_id as ${readBack ?? 'empty'}, not ${keyId}. Set it in the 1Password app, or the next rotation asks which key to retire.`);
        }
      }
    }
    value = null;
    await finish('issue');
    await finish('store');
  } else {
    say('store', 'already done');
  }

  /** The stored value, read from 1Password for the step that needs it. */
  const stored = async (step: RotateStep): Promise<string> => {
    try {
      const field = pickValueField(await deps.op.readItem(spec.opItem));
      if (!field?.value) throw new Error(`The 1Password item "${spec.opItem}" holds no value.`);
      secrets.push(field.value);
      return field.value;
    } catch (err) {
      return stop(step, err);
    }
  };

  // 3: push
  if (!isDone('push')) {
    const value = await stored('push');
    try {
      st.priorDeploymentId = (await deps.railway.latestDeploymentId()) ?? undefined;
      st.pushedAt = deps.now().toISOString();
      await deps.state.save(spec.name, st);
      await deps.railway.setVariable(spec.railwayVariable, value);
    } catch (err) {
      stop('push', err);
    }
    say('push', `set ${spec.railwayVariable} on ${target.railwayService}/${target.railwayEnvironment}; the service redeploys`);
    await finish('push');
  } else {
    say('push', 'already done');
  }

  // 4: env
  if (!isDone('env')) {
    const value = await stored('env');
    try {
      await deps.env.setLine(spec.envVar, value);
    } catch (err) {
      stop('env', err);
    }
    say('env', `rewrote the ${spec.envVar} line in ${deps.env.path}`);
    await finish('env');
  } else {
    say('env', 'already done');
  }

  // 5: wait for the redeploy, then the ready line
  if (!isDone('wait')) {
    try {
      const t0 = Date.now();
      let deployment: RailwayDeployment | undefined;
      let readyLine: string | undefined;
      const pushedAt = Date.parse(st.pushedAt ?? '') || 0;
      while (!readyLine) {
        const all = await deps.railway.deployments();
        deployment = all
          .filter((d) => d.id !== st.priorDeploymentId && Date.parse(d.createdAt) >= pushedAt - 60_000)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (deployment && FAILED_DEPLOYMENT.has(deployment.status)) {
          throw new Error(`Deployment ${deployment.id} ended ${deployment.status}.`);
        }
        if (deployment) {
          readyLine = (await deps.railway.logs(deployment.id)).find((l) => l.includes(target.readyMarker));
        }
        if (readyLine) break;
        const limit = deployment ? timings.deployTimeoutMs + timings.readyTimeoutMs : timings.deployTimeoutMs;
        if (Date.now() - t0 > limit) {
          throw new Error(
            deployment
              ? `Deployment ${deployment.id} (${deployment.status}) printed no ready line in time.`
              : 'No new Railway deployment appeared in time.',
          );
        }
        await deps.sleep(timings.deployPollMs);
      }
      if (!readyLineSays(readyLine, spec.readyField, spec.readyValue)) {
        throw new Error(`Deployment ${deployment!.id} is up, but its ready line does not say ${spec.readyField}: ${spec.readyValue}.`);
      }
      st.deploymentId = deployment!.id;
      say('wait', `deployment ${deployment!.id} is up; ready line says ${spec.readyField}: ${spec.readyValue}`);
    } catch (err) {
      stop('wait', err);
    }
    await finish('wait');
  } else {
    say('wait', `already done: deployment ${st.deploymentId ?? 'unknown'}`);
  }

  // 6: verify
  if (!isDone('verify')) {
    const value = await stored('verify');
    try {
      const t0 = Date.now();
      let delay = timings.verifyFirstDelayMs;
      for (;;) {
        try {
          const verifier = deps.verifiers[spec.verify];
          if (!verifier) throw new Error(`No verify function named ${spec.verify} was supplied.`);
          await verifier(value);
          break;
        } catch (err) {
          // A new key answers Access Denied for its first seconds.
          if (Date.now() - t0 + delay > timings.verifyTimeoutMs) throw err;
          say('verify', `not yet (${(err instanceof Error ? err.message : String(err)).slice(0, 120)}); retrying in ${Math.round(delay / 1000)}s`);
          await deps.sleep(delay);
          delay = Math.min(delay * 2, timings.verifyMaxDelayMs);
        }
      }
    } catch (err) {
      stop('verify', err);
    }
    say('verify', spec.verifyDone);
    await finish('verify');
  } else {
    say('verify', 'already done');
  }

  // 7: retire
  if (!isDone('retire')) {
    if (spec.issuer !== 'tcld') {
      retire = 'not-applicable';
      say('retire', 'nothing to delete: regenerating the ping key already ended the old one');
      await finish('retire');
    } else if (!hasTcld) {
      retire = 'manual';
      st.retireNote = 'tcld absent: delete the old key in Temporal Cloud yourself';
      const old = st.oldKeyId ? `key id ${st.oldKeyId}` : 'the key issued before today';
      say('retire', `tcld is absent. In Temporal Cloud, Settings, API keys, delete ${old} on the ${spec.serviceAccount} service account.`);
      await finish('retire');
    } else {
      try {
        let oldId = st.oldKeyId;
        if (oldId) {
          const saId = options.serviceAccountId ?? (await deps.tcld.resolveServiceAccount(spec.serviceAccount!));
          if (!(await deps.tcld.listKeys(saId)).some((k) => k.id === oldId)) {
            say('retire', `the recorded old key ${oldId} is no longer in the service account key list; nothing to delete`);
            oldId = undefined;
            retire = 'not-applicable';
          }
        } else {
          const saId = options.serviceAccountId ?? (await deps.tcld.resolveServiceAccount(spec.serviceAccount!));
          const others = (await deps.tcld.listKeys(saId)).filter((k) => k.id !== st.newKeyId);
          if (others.length === 0) {
            say('retire', 'the service account holds no other key; nothing to delete');
            retire = 'not-applicable';
          } else {
            say('retire', 'the item has no key_id for the old key. The service account holds:');
            others.forEach((k, i) => deps.log(`           ${i + 1}. ${k.id}${k.name ? ` (${k.name})` : ''}${k.expires ? ` expires ${k.expires}` : ''}${k.disabled ? ' (disabled)' : ''}`));
            const pick = (await deps.prompt.line('Number of the old key to delete (Enter to skip)', '')).trim();
            const chosen = /^\d+$/.test(pick) ? others[Number(pick) - 1] : undefined;
            oldId = chosen?.id;
          }
        }
        if (oldId) {
          if (oldId === st.newKeyId) throw new Error('The old key id equals the new key id; refusing to delete it.');
          if (await deps.prompt.confirm(`Delete the old key ${oldId} at Temporal Cloud?`)) {
            const requested = await deps.tcld.deleteKey(oldId);
            retire = 'deleted';
            // The issuer answers at once with a pending request and finishes within seconds. The
            // delete is asked for and cannot be undone, so retire is done from here; the poll only reports.
            say('retire', `delete requested for old key ${oldId}${requested ? ` (issuer state: ${requested})` : ''}`);
            await finish('retire');
            try {
              const saId = options.serviceAccountId ?? (await deps.tcld.resolveServiceAccount(spec.serviceAccount!));
              const t0 = Date.now();
              let gone = false;
              for (;;) {
                if (!(await deps.tcld.listKeys(saId)).some((k) => k.id === oldId)) {
                  gone = true;
                  break;
                }
                if (Date.now() - t0 + timings.deletePollMs > timings.deleteTimeoutMs) break;
                await deps.sleep(timings.deletePollMs);
              }
              say(
                'retire',
                gone
                  ? `old key ${oldId} no longer appears in the service account key list`
                  : `old key ${oldId} is still listed after ${Math.round(timings.deleteTimeoutMs / 1000)}s; the issuer finishes the delete on its own, so check the list later`,
              );
            } catch (err) {
              say('retire', `could not confirm the delete (${err instanceof Error ? err.message : String(err)}); the request was sent`);
            }
          } else {
            retire = 'declined';
            say('retire', `left old key ${oldId} in place; rerun this command to be asked again`);
          }
        } else if (retire !== 'not-applicable') {
          retire = 'declined';
          say('retire', 'no key chosen; rerun this command to be asked again');
        } else {
          await finish('retire');
        }
      } catch (err) {
        stop('retire', err);
      }
    }
  } else {
    say('retire', 'already done');
  }

  const completed = isDone('retire');
  if (completed) await deps.state.clear(spec.name);
  return {
    completed,
    deploymentId: st.deploymentId,
    newKeyId: st.newKeyId,
    expires: st.expires,
    retire: retire === 'pending' ? 'not-applicable' : retire,
    remaining: remaining(),
    warnings,
  };
}
