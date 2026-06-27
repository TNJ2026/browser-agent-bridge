import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importSessionsModule() {
  const source = await readFile(new URL('../extension/sw/sessions.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

async function setup(session) {
  const { createSessionHandlers, SESSION_STORAGE_KEY } = await importSessionsModule();
  const store = { [SESSION_STORAGE_KEY]: { [session.id]: session } };
  const calls = { detach: [], removed: [], ungrouped: [] };
  const handlers = createSessionHandlers({
    assertString: (v, name) => { if (typeof v !== 'string' || !v) throw new Error(`${name} required`); return v; },
    assertTabId: (v) => v,
    assertUrlAllowed: async () => {},
    assertTabAllowed: async () => {},
    normalizeTab: (t) => t,
    errorMessage: (e) => String(e),
    maybeEnableTemporaryCspBypassForUrl: async () => {},
    detachDebugger: async (tabId) => { calls.detach.push(tabId); },
    chromeApi: {
      storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (obj) => { Object.assign(store, obj); } } },
      tabs: {
        remove: async (ids) => { calls.removed.push(...(Array.isArray(ids) ? ids : [ids])); },
        ungroup: async (ids) => { calls.ungrouped.push(...(Array.isArray(ids) ? ids : [ids])); }
      }
    }
  });
  return { handlers, calls, store, SESSION_STORAGE_KEY };
}

test('session.stop detaches debuggers when tabs stay open (ungroup path)', async () => {
  const { handlers, calls, store, SESSION_STORAGE_KEY } = await setup({ id: 's1', tabIds: [10, 11] });
  const res = await handlers.sessionStop({ sessionId: 's1' });

  assert.equal(res.stopped, 's1');
  assert.deepEqual(calls.detach.sort(), [10, 11]);
  assert.deepEqual(calls.ungrouped.sort(), [10, 11]);
  assert.deepEqual(calls.removed, []);
  assert.equal(store[SESSION_STORAGE_KEY].s1, undefined); // session record cleared
});

test('session.stop with closeTabs removes tabs and lets Chrome auto-detach', async () => {
  const { handlers, calls } = await setup({ id: 's2', tabIds: [20] });
  await handlers.sessionStop({ sessionId: 's2', closeTabs: true });

  assert.deepEqual(calls.removed, [20]);
  assert.deepEqual(calls.detach, []); // closing the tab detaches the debugger
  assert.deepEqual(calls.ungrouped, []);
});
