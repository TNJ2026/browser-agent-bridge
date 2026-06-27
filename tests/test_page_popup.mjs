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
    this.groupCalls = [];
    this.tabState = new Map(); // id -> tab object (overrides the default)
    const self = this;
    this.tabs = {
      get: async (id) => self.tabState.get(id) || { id, url: 'https://example.com' },
      group: async ({ groupId, tabIds }) => {
        self.groupCalls.push({ groupId, tabIds });
        for (const tid of tabIds) {
          const prev = self.tabState.get(tid) || { id: tid, url: 'https://example.com' };
          self.tabState.set(tid, { ...prev, groupId });
        }
        return groupId;
      },
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

  setTab(tab) { this.tabState.set(tab.id, tab); }
  triggerCreated(tab) { for (const l of [...this.tabs.onCreated.listeners]) l(tab); }
  triggerUpdated(tabId, changeInfo, tab) { for (const l of [...this.tabs.onUpdated.listeners]) l(tabId, changeInfo, tab); }
}

async function makeHandlers(chromeApi) {
  const { createPageHandlers } = await importPageModule();
  return createPageHandlers({
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
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('page.waitForPopup resolves when popup is created', async () => {
  const chromeApi = new MockChromeApi();
  const handlers = await makeHandlers(chromeApi);
  const promise = handlers.pageWaitForPopup({ tabId: 1, timeoutMs: 100 });
  await tick();
  chromeApi.triggerCreated({ id: 2, openerTabId: 1, url: 'about:blank' });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.tab.id, 2);
});

test('page.waitForPopup resolves and filters by URL pattern', async () => {
  const chromeApi = new MockChromeApi();
  const handlers = await makeHandlers(chromeApi);
  const promise = handlers.pageWaitForPopup({ tabId: 1, urlContains: 'success', timeoutMs: 200 });
  await tick();
  chromeApi.triggerCreated({ id: 3, openerTabId: 1, url: 'about:blank' });          // no match yet
  chromeApi.triggerUpdated(3, {}, { id: 3, url: 'https://example.com/success' });    // now matches
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

test('page.waitForPopup ignores popups opened by other tabs', async () => {
  const chromeApi = new MockChromeApi();
  const handlers = await makeHandlers(chromeApi);
  const promise = handlers.pageWaitForPopup({ tabId: 1, timeoutMs: 30 });
  await tick();
  chromeApi.triggerCreated({ id: 9, openerTabId: 99, url: 'about:blank' }); // different opener
  await assert.rejects(promise, /PageWaitForPopupTimeout/);
});

test('page.waitForPopup adopts the popup into the opener Agent group', async () => {
  const chromeApi = new MockChromeApi();
  chromeApi.setTab({ id: 1, url: 'https://example.com', groupId: 5 }); // opener in Agent group 5
  const handlers = await makeHandlers(chromeApi);
  const promise = handlers.pageWaitForPopup({ tabId: 1, timeoutMs: 100 });
  await tick();
  chromeApi.triggerCreated({ id: 2, openerTabId: 1, url: 'about:blank' });
  const res = await promise;
  assert.deepEqual(chromeApi.groupCalls, [{ groupId: 5, tabIds: [2] }]);
  assert.equal(res.tab.id, 2);
  assert.equal(res.tab.groupId, 5); // now Agent-managed, so it can be driven
});

test('page.waitForPopup adopt:false leaves the popup ungrouped', async () => {
  const chromeApi = new MockChromeApi();
  chromeApi.setTab({ id: 1, url: 'https://example.com', groupId: 5 });
  const handlers = await makeHandlers(chromeApi);
  const promise = handlers.pageWaitForPopup({ tabId: 1, adopt: false, timeoutMs: 100 });
  await tick();
  chromeApi.triggerCreated({ id: 2, openerTabId: 1, url: 'about:blank' });
  const res = await promise;
  assert.equal(chromeApi.groupCalls.length, 0);
  assert.equal(res.tab.id, 2);
});

test('page.waitForPopup grouping failure does not mask the capture', async () => {
  const chromeApi = new MockChromeApi();
  chromeApi.setTab({ id: 1, url: 'https://example.com', groupId: 5 });
  chromeApi.tabs.group = async () => { throw new Error('group boom'); };
  const handlers = await makeHandlers(chromeApi);
  const promise = handlers.pageWaitForPopup({ tabId: 1, timeoutMs: 100 });
  await tick();
  chromeApi.triggerCreated({ id: 2, openerTabId: 1, url: 'about:blank' });
  const res = await promise;
  assert.equal(res.ok, true);
  assert.equal(res.tab.id, 2); // captured despite grouping failure
});

test('page.waitForPopup removes every listener on finish (no leak with multiple popups)', async () => {
  const chromeApi = new MockChromeApi();
  const handlers = await makeHandlers(chromeApi);
  const promise = handlers.pageWaitForPopup({ tabId: 1, urlContains: 'done', timeoutMs: 200 });
  await tick();
  // two non-matching popups from the opener -> two onUpdated listeners registered
  chromeApi.triggerCreated({ id: 2, openerTabId: 1, url: 'about:blank' });
  chromeApi.triggerCreated({ id: 3, openerTabId: 1, url: 'about:blank' });
  assert.equal(chromeApi.tabs.onUpdated.listeners.length, 2);
  // resolve via the second popup; the first popup's listener must not leak
  chromeApi.triggerUpdated(3, {}, { id: 3, url: 'https://example.com/done' });
  await promise;
  assert.equal(chromeApi.tabs.onUpdated.listeners.length, 0);
  assert.equal(chromeApi.tabs.onCreated.listeners.length, 0);
});
