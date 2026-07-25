import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/dom-stub.mjs';
import {
  APPEARANCES,
  DEFAULT_APPEARANCE,
  STORAGE_KEY,
  APPEARANCE_CHANGE_EVENT,
  getAppearance,
  setAppearance,
} from '../src/lib/appearance.mjs';

test('APPEARANCES is exactly modern and retro, modern is the default', () => {
  assert.deepEqual(APPEARANCES, ['modern', 'retro']);
  assert.equal(DEFAULT_APPEARANCE, 'modern');
});

test('getAppearance defaults to modern when nothing is stored', () => {
  localStorage.removeItem(STORAGE_KEY);
  assert.equal(getAppearance(), 'modern');
});

test('setAppearance applies the attribute, persists, and returns the resolved mode', () => {
  const resolved = setAppearance('retro');

  assert.equal(resolved, 'retro');
  assert.equal(document.documentElement.dataset.appearance, 'retro');
  assert.equal(localStorage.getItem(STORAGE_KEY), 'retro');
  assert.equal(getAppearance(), 'retro');
});

test('setAppearance("modern") clears the attribute rather than setting it', () => {
  setAppearance('retro');
  setAppearance('modern');

  assert.equal(document.documentElement.dataset.appearance, undefined);
  assert.equal(getAppearance(), 'modern');
});

test('setAppearance falls back to modern for any value outside APPEARANCES', () => {
  for (const bogus of ['retro-max', '', null, undefined, 'Retro', 123]) {
    setAppearance('retro');
    const resolved = setAppearance(bogus);
    assert.equal(resolved, 'modern');
    assert.equal(document.documentElement.dataset.appearance, undefined);
  }
});

test('setAppearance dispatches APPEARANCE_CHANGE_EVENT with the resolved mode', () => {
  let received;
  document.addEventListener(APPEARANCE_CHANGE_EVENT, (event) => { received = event.detail; });

  setAppearance('retro');
  assert.deepEqual(received, { mode: 'retro' });

  setAppearance('nonsense');
  assert.deepEqual(received, { mode: 'modern' });
});
