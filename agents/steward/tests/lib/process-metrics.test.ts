import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  sampleProcess,
  sdkMetricsOptions,
  startProcessMetrics,
  type ProcessMeter,
  type ProcessReading,
} from '../../src/lib/temporal-logger.js';

/**
 * The worker's own memory and CPU, exported through the SDK meter (STW-604).
 * Tested on the sampling function and a fake meter; `Runtime.install` runs once
 * per process in the worker entry points and is not called here.
 */

function reading(over: Partial<ProcessReading> = {}): ProcessReading {
  return { rssBytes: 1000, heapUsedBytes: 400, cpuUserMicros: 0, cpuSystemMicros: 0, ...over };
}

interface Call {
  metric: string;
  value: number;
  tags?: Record<string, unknown>;
}

function fakeMeter() {
  const calls: Call[] = [];
  const meterTags: Record<string, unknown>[] = [];
  const meter = {
    withTags(tags: Record<string, unknown>) {
      meterTags.push(tags);
      return meter;
    },
    createGauge: (name: string) => ({ set: (value: number) => calls.push({ metric: name, value }) }),
    createCounter: (name: string) => ({
      add: (value: number, tags?: Record<string, unknown>) => calls.push({ metric: name, value, tags }),
    }),
  };
  return { meter: meter as unknown as ProcessMeter, calls, meterTags };
}

test('the first sample reports memory as read and all CPU so far', () => {
  const s = sampleProcess(reading({ cpuUserMicros: 5500, cpuSystemMicros: 1200 }), undefined);
  assert.equal(s.rssBytes, 1000);
  assert.equal(s.heapUsedBytes, 400);
  assert.equal(s.cpuUserMs, 5);
  assert.equal(s.cpuSystemMs, 1);
  assert.deepEqual(s.carry, { userMicros: 500, systemMicros: 200 });
});

test('the sub-millisecond remainder carries to the next sample, so no CPU is lost', () => {
  const a = reading({ cpuUserMicros: 1600 });
  const first = sampleProcess(a, undefined);
  assert.equal(first.cpuUserMs, 1);
  const b = reading({ cpuUserMicros: 2500 });
  const second = sampleProcess(b, a, first.carry);
  // 900 micros since a, plus 600 carried: 1500 micros, so 1 ms with 500 left.
  assert.equal(second.cpuUserMs, 1);
  assert.equal(second.carry.userMicros, 500);
});

test('a CPU reading that goes backwards counts as zero', () => {
  const s = sampleProcess(reading({ cpuUserMicros: 100 }), reading({ cpuUserMicros: 9000 }));
  assert.equal(s.cpuUserMs, 0);
});

test('with any of the three variables unset, no metrics options exist, so no sampler starts', () => {
  const env = { STEWARD_METRICS_OTLP_URL: 'https://x.example/otlp/v1/metrics', STEWARD_METRICS_OTLP_USER: 'u' };
  assert.equal(sdkMetricsOptions(env, 'hosted'), undefined);
  assert.equal(sdkMetricsOptions({}, 'local'), undefined);
});

test('the sampler tags every series, samples at start, then every 60 s, on an unref timer', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { meter, calls, meterTags } = fakeMeter();
  const stop = startProcessMetrics(meter, 'hosted', () => reading({ cpuUserMicros: 3000 }));
  try {
    assert.deepEqual(meterTags, [{ worker_kind: 'hosted' }]);
    // The reading at start.
    assert.deepEqual(
      calls.map((c) => c.metric),
      [
        'steward_process_resident_memory',
        'steward_process_heap_used',
        'steward_process_cpu',
        'steward_process_cpu',
      ],
    );
    assert.deepEqual(
      calls.filter((c) => c.metric === 'steward_process_cpu').map((c) => c.tags),
      [{ mode: 'user' }, { mode: 'system' }],
    );
    mock.timers.tick(59_999);
    assert.equal(calls.length, 4);
    mock.timers.tick(1);
    assert.equal(calls.length, 8);
  } finally {
    stop();
    mock.timers.reset();
  }
});

test('the interval is unref, so it never keeps the process alive', () => {
  const real = globalThis.setInterval;
  let unrefCalled = false;
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    const t = real(fn, ms);
    const originalUnref = t.unref.bind(t);
    t.unref = () => {
      unrefCalled = true;
      return originalUnref();
    };
    return t;
  }) as typeof setInterval;
  const { meter } = fakeMeter();
  const stop = startProcessMetrics(meter, 'local', () => reading());
  globalThis.setInterval = real;
  stop();
  assert.equal(unrefCalled, true);
});

test('a second call starts no second sampler: one process, one sampler', () => {
  const a = fakeMeter();
  const b = fakeMeter();
  const stop = startProcessMetrics(a.meter, 'hosted', () => reading());
  try {
    const again = startProcessMetrics(b.meter, 'hosted', () => reading());
    assert.equal(again, stop);
    assert.equal(b.calls.length, 0);
    assert.equal(b.meterTags.length, 0);
  } finally {
    stop();
  }
});

test('a throwing read is caught, logged once at WARN, and the timer keeps running', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const { meter } = fakeMeter();
  const warnings: unknown[] = [];
  let reads = 0;
  const stop = startProcessMetrics(
    meter,
    'local',
    () => {
      reads += 1;
      throw new Error('cpuUsage failed');
    },
    { warn: (...args: unknown[]) => void warnings.push(args) } as never,
  );
  try {
    mock.timers.tick(180_000);
    assert.equal(reads, 4);
    assert.equal(warnings.length, 1);
  } finally {
    stop();
    mock.timers.reset();
  }
});

test('a throwing gauge is caught the same way', () => {
  const warnings: unknown[] = [];
  const meter = {
    withTags() {
      return meter;
    },
    createGauge: () => ({
      set() {
        throw new Error('meter gone');
      },
    }),
    createCounter: () => ({ add() {} }),
  } as unknown as ProcessMeter;
  const stop = startProcessMetrics(meter, 'local', () => reading(), {
    warn: (...args: unknown[]) => void warnings.push(args),
  } as never);
  stop();
  assert.equal(warnings.length, 1);
});
