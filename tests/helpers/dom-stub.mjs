/**
 * Minimal browser-global stubs so src/lib/appearance.mjs (and anything that
 * imports it, e.g. webmcp-tools.mjs) can run under `node --test`, which has
 * no DOM. Import this for its side effect before importing appearance.mjs.
 */

class FakeStorage {
  constructor() { this.store = new Map(); }
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; }
  setItem(key, value) { this.store.set(key, String(value)); }
  removeItem(key) { this.store.delete(key); }
}

const listeners = new Map();

globalThis.localStorage = new FakeStorage();

globalThis.document = {
  documentElement: { dataset: {} },
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  },
  dispatchEvent(event) {
    for (const handler of listeners.get(event.type) ?? []) handler(event);
  },
};

globalThis.CustomEvent = class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};
