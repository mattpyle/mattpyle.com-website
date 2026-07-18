import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_ORIGIN, resolveSiteOrigin } from '../src/data/site-origin.mjs';

test('production builds use the canonical origin', () => {
  assert.equal(
    resolveSiteOrigin({ VERCEL_ENV: 'production', VERCEL_URL: 'example.vercel.app' }),
    PRODUCTION_ORIGIN,
  );
});

test('preview builds use the Vercel deployment origin', () => {
  assert.equal(
    resolveSiteOrigin({ VERCEL_ENV: 'preview', VERCEL_URL: 'preview-example.vercel.app' }),
    'https://preview-example.vercel.app',
  );
});

test('local builds fall back to the canonical origin', () => {
  assert.equal(resolveSiteOrigin({}), PRODUCTION_ORIGIN);
});
