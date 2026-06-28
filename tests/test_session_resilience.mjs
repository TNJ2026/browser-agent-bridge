import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

async function importPageModule() {
  const source = await readFile(new URL('../extension/sw/page.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

test('recentPopups session persistence', async () => {
  const { createPageHandlers } = await importPageModule();

  // Mock chromeApi
  const sessionStore = new Map();
  let onCreatedListener = null;

  const chromeApi = {
    storage: {
      session: {
        async get(keys) {
          const res = {};
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) res[k] = sessionStore.get(k);
          return res;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
        }
      }
    },
    tabs: {
      onCreated: {
        addListener(fn) { onCreatedListener = fn; },
        removeListener() {}
      },
      onUpdated: {
        addListener() {},
        removeListener() {}
      }
    }
  };

  createPageHandlers({
    assertTabId: id => id,
    assertString: () => {},
    assertTabAllowed: async () => {},
    assertUrlAllowed: async () => {},
    recordAction: async () => {},
    normalizeTab: t => t,
    chromeApi
  });

  assert.ok(onCreatedListener);

  // Simulate tab creation
  await onCreatedListener({ id: 100, openerTabId: 42 });
  
  // Verify it was persisted to storage
  let popups = sessionStore.get('recentPopups');
  assert.equal(popups.length, 1);
  assert.equal(popups[0].tabId, 100);
  assert.equal(popups[0].openerTabId, 42);

  // Simulate SW wake-up (new handlers created with same session storage)
  const handlersNew = createPageHandlers({
    assertTabId: id => id,
    assertString: () => {},
    assertTabAllowed: async () => {},
    assertUrlAllowed: async () => {},
    recordAction: async () => {},
    normalizeTab: t => t,
    chromeApi
  });

  // Yield execution to allow loadRecentPopups startup promise to resolve
  await new Promise(resolve => setTimeout(resolve, 10));

  // Let's mock tabs.get for the lookback popup resolution
  chromeApi.tabs.get = async (id) => ({ id, openerTabId: 42, url: 'https://test.com' });

  // Call pageWaitForPopup
  const result = await handlersNew.pageWaitForPopup({ tabId: 42, popupLookbackMs: 5000, timeoutMs: 1000 });
  
  assert.equal(result.ok, true);
  assert.equal(result.tab.id, 100);

  // Verify popup was consumed and removed from session storage
  popups = sessionStore.get('recentPopups');
  assert.equal(popups.length, 0);
});
