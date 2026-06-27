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
  const record = [];
  const handlers = createPageHandlers({
    assertTabId: (v) => v,
    assertString: (v, name) => { if (typeof v !== 'string' || !v) throw new Error(`${name} required`); return v; },
    assertTabAllowed: async () => {},
    assertUrlAllowed: async () => {},
    maybeEnableTemporaryCspBypassForUrl: async () => {},
    maybeEnableTemporaryCspBypass: async () => {},
    recordAction: async (tabId, action, meta) => { record.push({ action, meta }); },
    normalizeTab: (t) => t,
    waitForTabComplete: async () => {},
    sleep: async () => {},
    ensureContentScripts: async () => {},
    captureTabScreenshot: async () => '',
    attachDebugger: async () => {},
    cdp: async (tabId, method, params) => { calls.push({ method, params }); return {}; },
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 } }),
    networkEventsByTab: new Map(),
    dialogsByTab: new Map(),
    defaultTimeoutMs: 30,
    chromeApi: { tabs: { get: async () => ({ id: 1 }) } }
  });
  return { handlers, calls, record };
}

const find = (calls, method) => calls.find(c => c.method === method);

test('setExtraHTTPHeaders sends the headers and records names only', async () => {
  const { handlers, calls, record } = await makeHandlers();
  const res = await handlers.pageSetExtraHTTPHeaders({ tabId: 1, headers: { 'X-Test': 'a', Authorization: 'Bearer secret' } });

  const c = find(calls, 'Network.setExtraHTTPHeaders');
  assert.deepEqual(c.params.headers, { 'X-Test': 'a', Authorization: 'Bearer secret' });
  assert.deepEqual(res.headers, ['X-Test', 'Authorization']);
  // recording must not capture header values (could be auth tokens)
  assert.deepEqual(record[0].meta, { headers: ['X-Test', 'Authorization'] });
});

test('setExtraHTTPHeaders rejects a non-object headers param', async () => {
  const { handlers } = await makeHandlers();
  await assert.rejects(handlers.pageSetExtraHTTPHeaders({ tabId: 1, headers: 'nope' }), /headers object/);
});

test('setUserAgent overrides the user agent and optional fields', async () => {
  const { handlers, calls } = await makeHandlers();
  await handlers.pageSetUserAgent({ tabId: 1, userAgent: 'Custom/1.0', acceptLanguage: 'ja', platform: 'Linux' });
  const c = find(calls, 'Emulation.setUserAgentOverride');
  assert.equal(c.params.userAgent, 'Custom/1.0');
  assert.equal(c.params.acceptLanguage, 'ja');
  assert.equal(c.params.platform, 'Linux');
});

test('setUserAgent requires a userAgent string', async () => {
  const { handlers } = await makeHandlers();
  await assert.rejects(handlers.pageSetUserAgent({ tabId: 1 }), /userAgent required/);
});
