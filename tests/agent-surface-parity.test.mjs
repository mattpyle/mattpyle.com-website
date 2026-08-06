import test from 'node:test';
import assert from 'node:assert/strict';
import { hashableBody } from '../scripts/agent-surface-parity.mjs';

// The false positive this covers: two clean deploys in a row reported /webmcp/tools.json and
// /webmcp/index.json as differences, identical byte counts with changed hashes, purely because
// both carry a build-time `generated` timestamp. A parity compare that cries wolf on every deploy
// is a check nobody reads.

test('the WebMCP catalogs hash the same across deploys that only change `generated`', () => {
  const before = Buffer.from(
    JSON.stringify({ generated: '2026-08-04T06:00:00.000Z', tools: [{ name: 'describe_site' }] })
  );
  const after = Buffer.from(
    JSON.stringify({ generated: '2026-08-06T21:14:00.000Z', tools: [{ name: 'describe_site' }] })
  );

  for (const path of ['/webmcp/tools.json', '/webmcp/index.json']) {
    assert.equal(
      hashableBody(path, before).toString(),
      hashableBody(path, after).toString(),
      `${path} should hash identically across a no-op deploy`
    );
  }
});

test('a real change to a WebMCP catalog still differs', () => {
  const before = Buffer.from(JSON.stringify({ generated: 'a', tools: [{ name: 'describe_site' }] }));
  const after = Buffer.from(JSON.stringify({ generated: 'a', tools: [{ name: 'renamed' }] }));
  assert.notEqual(
    hashableBody('/webmcp/tools.json', before).toString(),
    hashableBody('/webmcp/tools.json', after).toString()
  );
});

test('every other surface is hashed byte for byte', () => {
  const body = Buffer.from('{"generated":"2026-08-06T21:14:00.000Z"}');
  assert.equal(hashableBody('/llms.txt', body), body);
  assert.equal(hashableBody('/.well-known/agent-card.json', body), body);
});

test('a catalog that stops being JSON is hashed as it arrived', () => {
  const body = Buffer.from('<!doctype html>deployment protection');
  assert.equal(hashableBody('/webmcp/tools.json', body).toString(), body.toString());
});
