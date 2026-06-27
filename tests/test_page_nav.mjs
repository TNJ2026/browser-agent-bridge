import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importPageModule() {
  const source = await readFile(new URL('../extension/sw/page.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

async function makeHandlers() {
  const { createPageHandlers } = await importPageModule();
  const calls = [];
  let waited = 0;
  const handlers = createPageHandlers({
    assertTabId: (v) => v,
    assertString: (v) => v,
    assertTabAllowed: async () => {},
    assertUrlAllowed: async () => {},
    maybeEnableTemporaryCspBypassForUrl: async () => {},
    maybeEnableTemporaryCspBypass: async () => {},
    recordAction: async () => {},
    normalizeTab: (t) => t,
    waitForTabComplete: async () => { waited += 1; },
    sleep: async () => {},
    ensureContentScripts: async () => {},
    captureTabScreenshot: async () => '',
    attachDebugger: async () => {},
    cdp: async () => ({}),
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 } }),
    networkEventsByTab: new Map(),
    dialogsByTab: new Map(),
    defaultTimeoutMs: 30,
    chromeApi: {
      tabs: {
        get: async (id) => ({ id, url: 'https://example.com', status: 'complete' }),
        reload: async (id, props) => { calls.push({ method: 'reload', id, props }); },
        goBack: async (id) => { calls.push({ method: 'goBack', id }); },
        goForward: async (id) => { calls.push({ method: 'goForward', id }); }
      }
    }
  });
  return { handlers, calls, get waited() { return waited; } };
}

test('page.reload reloads and waits for load', async () => {
  const ctx = await makeHandlers();
  const res = await ctx.handlers.pageReload({ tabId: 5, bypassCache: true });
  assert.equal(res.tab.id, 5);
  const c = ctx.calls.find(x => x.method === 'reload');
  assert.equal(c.id, 5);
  assert.deepEqual(c.props, { bypassCache: true });
  assert.equal(ctx.waited, 1);
});

test('page.reload can skip waiting with wait:false', async () => {
  const ctx = await makeHandlers();
  await ctx.handlers.pageReload({ tabId: 5, wait: false });
  assert.equal(ctx.waited, 0);
});

test('page.goBack navigates back', async () => {
  const ctx = await makeHandlers();
  await ctx.handlers.pageGoBack({ tabId: 5 });
  assert.ok(ctx.calls.find(x => x.method === 'goBack' && x.id === 5));
  assert.equal(ctx.waited, 1);
});

test('page.goForward navigates forward', async () => {
  const ctx = await makeHandlers();
  await ctx.handlers.pageGoForward({ tabId: 5 });
  assert.ok(ctx.calls.find(x => x.method === 'goForward' && x.id === 5));
});
