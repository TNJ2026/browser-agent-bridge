import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importPageModule() {
  const source = await readFile(new URL('../extension/sw/page.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FUTURE = () => Date.now() + 1_000_000;

// One request lifecycle: requestWillBeSent -> responseReceived -> loadingFinished.
function networkEvents({ url = 'https://api.example.com/items', method = 'GET', status = 200, mimeType = 'application/json', encodedDataLength = 1234, finished = true } = {}) {
  const requestId = 'req-1';
  const ts = FUTURE();
  const events = [
    { method: 'Network.requestWillBeSent', timestamp: ts, params: { requestId, request: { method, url } } },
    { method: 'Network.responseReceived', timestamp: ts + 1, params: { requestId, type: 'XHR', response: { url, status, statusText: 'OK', mimeType, headers: {} } } }
  ];
  if (finished) events.push({ method: 'Network.loadingFinished', timestamp: ts + 2, params: { requestId, encodedDataLength } });
  return new Map([[1, events]]);
}

function makeHandlers({ events, body, base64 = false } = {}) {
  return importPageModule().then(({ createPageHandlers }) => createPageHandlers({
    assertTabId: (v) => v,
    assertString: (v) => v,
    assertTabAllowed: async () => {},
    assertUrlAllowed: async () => {},
    maybeEnableTemporaryCspBypassForUrl: async () => {},
    maybeEnableTemporaryCspBypass: async () => {},
    recordAction: async () => {},
    normalizeTab: (t) => t,
    waitForTabComplete: async () => {},
    sleep,
    ensureContentScripts: async () => {},
    captureTabScreenshot: async () => '',
    attachDebugger: async () => {},
    cdp: async (tabId, cdpMethod) => {
      if (cdpMethod === 'Network.getResponseBody') {
        if (body == null) throw new Error('No data found');
        return base64 ? { body: btoa(body), base64Encoded: true } : { body, base64Encoded: false };
      }
      return {};
    },
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: null, frameSelector: null }),
    networkEventsByTab: events,
    dialogsByTab: new Map(),
    defaultTimeoutMs: 40,
    chromeApi: { tabs: { get: async () => ({ id: 1, url: 'https://api.example.com' }) } }
  }));
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the wait to time out');
}

const JSON_BODY = '{"ok":true,"items":[{"id":7,"name":"a"}]}';

test('bodyContains matches the response body', async () => {
  const handlers = await makeHandlers({ events: networkEvents(), body: JSON_BODY });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', bodyContains: '"id":7', timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.ok, true);
  assert.equal(res.response.bodyMatched, true);
  assert.equal(res.response.bodyBytes, JSON_BODY.length);
  assert.equal(res.response.bodyPreview, undefined); // not included by default
});

test('includeBody returns a bounded body preview', async () => {
  const handlers = await makeHandlers({ events: networkEvents(), body: JSON_BODY });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', bodyContains: 'ok', includeBody: true, timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.response.bodyPreview, JSON_BODY);
});

test('bodyRegex matches the response body', async () => {
  const handlers = await makeHandlers({ events: networkEvents(), body: JSON_BODY });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', bodyRegex: '"id":\\s*7', timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.response.bodyMatched, true);
});

test('jsonPath + jsonEquals matches a nested value', async () => {
  const handlers = await makeHandlers({ events: networkEvents(), body: JSON_BODY });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', jsonPath: 'items[0].id', jsonEquals: 7, timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.response.bodyMatched, true);
});

test('jsonPath existence matches without a value constraint', async () => {
  const handlers = await makeHandlers({ events: networkEvents(), body: JSON_BODY });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', jsonPath: 'ok', timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.response.bodyMatched, true);
});

test('base64-encoded bodies are decoded before matching', async () => {
  const handlers = await makeHandlers({ events: networkEvents(), body: JSON_BODY, base64: true });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', jsonPath: 'items[0].name', jsonContains: 'a', timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.response.bodyMatched, true);
});

test('mimeType filter matches without fetching the body', async () => {
  const handlers = await makeHandlers({ events: networkEvents({ mimeType: 'application/json' }), body: null });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', mimeType: 'json', timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.response.mimeType, 'application/json');
  assert.equal(res.response.bodyMatched, undefined);
});

test('minSize matches the wire size from loadingFinished', async () => {
  const handlers = await makeHandlers({ events: networkEvents({ encodedDataLength: 1234 }), body: JSON_BODY });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', minSize: 1000, timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.response.encodedDataLength, 1234);
});

test('maxSize rejects oversized responses (times out)', async () => {
  const handlers = await makeHandlers({ events: networkEvents({ encodedDataLength: 5000 }), body: JSON_BODY });
  const error = await captureRejection(
    handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', maxSize: 1000, timeoutMs: 40, intervalMs: 10 })
  );
  assert.equal(error.code, 'PAGE_WAIT_FOR_RESPONSE_TIMEOUT');
});

test('body filters wait for loadingFinished before matching', async () => {
  const handlers = await makeHandlers({ events: networkEvents({ finished: false }), body: JSON_BODY });
  const error = await captureRejection(
    handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', bodyContains: 'ok', timeoutMs: 40, intervalMs: 10 })
  );
  assert.equal(error.code, 'PAGE_WAIT_FOR_RESPONSE_TIMEOUT');
});

test('a non-matching body times out with the filters in the diagnostic', async () => {
  const handlers = await makeHandlers({ events: networkEvents(), body: JSON_BODY });
  const error = await captureRejection(
    handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', bodyContains: 'NOT-PRESENT', timeoutMs: 40, intervalMs: 10 })
  );
  assert.equal(error.code, 'PAGE_WAIT_FOR_RESPONSE_TIMEOUT');
  assert.equal(error.diagnostic.filters.bodyContains, true);
});

test('metadata-only waits are unchanged', async () => {
  const handlers = await makeHandlers({ events: networkEvents({ status: 200 }), body: null });
  const res = await handlers.pageWaitForResponse({ tabId: 1, urlContains: '/items', status: 200, method: 'GET', timeoutMs: 40, intervalMs: 10 });
  assert.equal(res.response.status, 200);
  assert.equal(res.response.method, 'GET');
});
