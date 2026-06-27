import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importPageModule() {
  const source = await readFile(new URL('../extension/sw/page.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

class MockChromeApi {
  constructor() {
    this.tabs = {
      get: async (id) => ({ id, url: 'https://example.com' }),
      onCreated: {
        listeners: [],
        addListener(fn) { this.listeners.push(fn); },
        removeListener(fn) { this.listeners = this.listeners.filter(l => l !== fn); }
      },
      onUpdated: {
        listeners: [],
        addListener(fn) { this.listeners.push(fn); },
        removeListener(fn) { this.listeners = this.listeners.filter(l => l !== fn); }
      }
    };
  }

  triggerCreated(tab) {
    for (const listener of this.tabs.onCreated.listeners) {
      listener(tab);
    }
  }

  triggerUpdated(tabId, changeInfo, tab) {
    for (const listener of this.tabs.onUpdated.listeners) {
      listener(tabId, changeInfo, tab);
    }
  }
}

async function makeHandlers(chromeApi) {
  const { createPageHandlers } = await importPageModule();
  const handlers = createPageHandlers({
    assertTabId: (v) => v,
    assertString: (v) => v,
    assertTabAllowed: async () => {},
    assertUrlAllowed: async () => {},
    maybeEnableTemporaryCspBypassForUrl: async () => {},
    maybeEnableTemporaryCspBypass: async () => {},
    recordAction: async () => {},
    normalizeTab: (t) => t,
    waitForTabComplete: async () => {},
    sleep: async () => {},
    ensureContentScripts: async () => {},
    captureTabScreenshot: async () => '',
    attachDebugger: async () => {},
    cdp: async () => ({}),
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 } }),
    networkEventsByTab: new Map(),
    dialogsByTab: new Map(),
    defaultTimeoutMs: 50,
    chromeApi
  });
  return handlers;
}

test('page.waitForPopup resolves when popup is created', async () => {
  const chromeApi = new MockChromeApi();
  const handlers = await makeHandlers(chromeApi);

  const promise = handlers.pageWaitForPopup({ tabId: 1, timeoutMs: 100 });
  await new Promise(r => setTimeout(r, 0));

  // Simulate a popup creation
  chromeApi.triggerCreated({ id: 2, openerTabId: 1, url: 'about:blank' });

  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.tab.id, 2);
});

test('page.waitForPopup resolves and filters by URL pattern', async () => {
  const chromeApi = new MockChromeApi();
  const handlers = await makeHandlers(chromeApi);

  const promise = handlers.pageWaitForPopup({ tabId: 1, urlContains: 'success', timeoutMs: 200 });
  await new Promise(r => setTimeout(r, 0));

  // Simulate popup creation (doesn't match yet)
  chromeApi.triggerCreated({ id: 3, openerTabId: 1, url: 'about:blank' });

  // Simulate popup update to match the filter
  chromeApi.triggerUpdated(3, {}, { id: 3, url: 'https://example.com/success' });

  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.tab.url, 'https://example.com/success');
});

test('page.waitForPopup times out if no popup matches', async () => {
  const chromeApi = new MockChromeApi();
  const handlers = await makeHandlers(chromeApi);

  await assert.rejects(
    handlers.pageWaitForPopup({ tabId: 1, timeoutMs: 30 }),
    /PageWaitForPopupTimeout/
  );
});
