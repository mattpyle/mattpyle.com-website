import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { consoleRequest } from '../helpers/console-request.js';
import { startConsoleServer } from '../../src/console/server.js';
import type { FindingsModel } from '../../src/console/findings-model.js';

/**
 * `POST /api/restart` with a test double for the spawn: the replacement must be started with the
 * console's own port while the listener is still open, the answer must go out, and only then does
 * the listener close and the process exit.
 */

const MODEL: FindingsModel = {
  generatedAt: '2026-11-01T12:00:00.000Z',
  repo: 'test/argus',
  sites: [],
  failedVerifies: [],
  cost: { treeCalls: 0, blobReads: 0, stateQueries: 0, dispatcherQueries: 0 },
};

const accepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

test('a restart spawns the replacement on the same port before the listener closes, answers, then exits', async () => {
  const events: string[] = [];
  const spawned: number[] = [];
  let listenerOpenAtSpawn: Promise<boolean> | null = null;
  let exited: () => void = () => {};
  const done = new Promise<void>((resolve) => (exited = resolve));
  const server = await startConsoleServer({
    port: 0,
    loadFindings: async () => MODEL,
    sendVerdict: async () => {
      throw new Error('no verdict in this test');
    },
    timeZone: 'America/Vancouver',
    webUi: 'https://web.example',
    namespace: 'ns.test',
    commit: 'abc1234',
    behindMaster: false,
    spawnReplacement: (port) => {
      spawned.push(port);
      events.push('spawn');
      listenerOpenAtSpawn = accepts(port);
    },
    exitProcess: () => {
      events.push('exit');
      exited();
    },
  });
  const res = await consoleRequest({
    port: server.port,
    path: '/api/restart',
    method: 'POST',
    origin: `http://127.0.0.1:${server.port}`,
    json: { token: server.token },
  });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body), { restarting: true });
  await done;
  assert.deepEqual(spawned, [server.port]);
  assert.deepEqual(events, ['spawn', 'exit']);
  assert.equal(await listenerOpenAtSpawn, true);
  assert.equal(await accepts(server.port), false);
});

test('a replacement that cannot start answers an error and keeps the console up', async () => {
  const server = await startConsoleServer({
    port: 0,
    loadFindings: async () => MODEL,
    sendVerdict: async () => {
      throw new Error('no verdict in this test');
    },
    timeZone: 'America/Vancouver',
    webUi: 'https://web.example',
    namespace: 'ns.test',
    commit: 'abc1234',
    behindMaster: false,
    spawnReplacement: () => {
      throw new Error('spawn failed');
    },
    exitProcess: () => assert.fail('the console must not exit when the replacement did not start'),
  });
  try {
    const res = await consoleRequest({
      port: server.port,
      path: '/api/restart',
      method: 'POST',
      origin: `http://127.0.0.1:${server.port}`,
      json: { token: server.token },
    });
    assert.equal(res.status, 502);
    assert.equal(await accepts(server.port), true);
  } finally {
    await server.close();
  }
});
