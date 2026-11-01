import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { consoleRequest } from '../helpers/console-request.js';
import { CONSOLE_RESTART_STUBS } from '../helpers/console-options.js';
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
    runSync: CONSOLE_RESTART_STUBS.runSync,
    runFix: CONSOLE_RESTART_STUBS.runFix,
    runVerify: CONSOLE_RESTART_STUBS.runVerify,
    commit: 'abc1234',
    behindMaster: false,
    spawnReplacement: (port) => {
      spawned.push(port);
      events.push('spawn');
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
  // The spawn ran inside the request, so the listener was open then; the 200 arrived before exit; the exit came last.
  // A socket opened at spawn time and checked here would race the close on a slow runner, so the order is the proof.
  assert.deepEqual(spawned, [server.port]);
  assert.deepEqual(events, ['spawn', 'exit']);
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
    runSync: CONSOLE_RESTART_STUBS.runSync,
    runFix: CONSOLE_RESTART_STUBS.runFix,
    runVerify: CONSOLE_RESTART_STUBS.runVerify,
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

test('a tab closed at the instant of the restart still lets the old process exit', async () => {
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
    runSync: CONSOLE_RESTART_STUBS.runSync,
    runFix: CONSOLE_RESTART_STUBS.runFix,
    runVerify: CONSOLE_RESTART_STUBS.runVerify,
    commit: 'abc1234',
    behindMaster: false,
    spawnReplacement: () => {},
    exitProcess: () => exited(),
  });
  // Send the restart, then drop the connection without reading the answer.
  const body = JSON.stringify({ token: server.token });
  const origin = `http://127.0.0.1:${server.port}`;
  const request = [
    'POST /api/restart HTTP/1.1',
    `Host: 127.0.0.1:${server.port}`,
    `Origin: ${origin}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n');
  const socket = net.connect(server.port, '127.0.0.1');
  socket.on('error', () => {});
  socket.once('connect', () => socket.write(request, () => socket.destroy()));
  await done;
  assert.equal(await accepts(server.port), false);
});
