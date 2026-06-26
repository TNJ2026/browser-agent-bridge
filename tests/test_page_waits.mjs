import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importPageModule() {
  const source = await readFile(new URL('../extension/sw/page.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDeps(overrides = {}) {
  return {
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
    cdp: async () => ({}),
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frameSelector: null, frame: { frameId: 0 } }),
    networkEventsByTab: new Map(),
    dialogsByTab: new Map(),
    defaultTimeoutMs: 30,
    chromeApi: {
      tabs: { get: async () => ({ id: 1, url: 'https://example.com/start', status: 'complete' }) },
      scripting: { executeScript: async () => [{ result: { found: false } }] }
    },
    ...overrides
  };
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the wait to time out, but it resolved');
}

function assertWaitTimeoutShape(error, { code, type, method }) {
  assert.equal(error.code, code);
  assert.equal(error.name, type);
  assert.ok(error.diagnostic, 'expected a structured diagnostic');
  assert.equal(error.diagnostic.type, type);
  assert.equal(error.diagnostic.method, method);
  assert.equal(typeof error.diagnostic.elapsedMs, 'number');
  assert.equal(error.diagnostic.timeoutMs, 25);
  assert.ok(error.message.includes(method), 'message should name the method');
}

test('waitForSelector timeout reports a unified diagnostic', async () => {
  const { createPageHandlers } = await importPageModule();
  const handlers = createPageHandlers(makeDeps());
  const error = await captureRejection(
    handlers.pageWaitForSelector({ tabId: 1, selector: '#missing', timeoutMs: 25, intervalMs: 10 })
  );
  assertWaitTimeoutShape(error, {
    code: 'PAGE_WAIT_FOR_SELECTOR_TIMEOUT',
    type: 'PageWaitForSelectorTimeout',
    method: 'page.waitForSelector'
  });
  assert.equal(error.diagnostic.selector, '#missing');
  assert.equal(error.diagnostic.foundInDom, false);
});

test('waitForSelector distinguishes found-but-not-visible', async () => {
  const { createPageHandlers } = await importPageModule();
  const handlers = createPageHandlers(makeDeps({
    chromeApi: {
      tabs: { get: async () => ({ id: 1, url: 'https://example.com', status: 'complete' }) },
      scripting: { executeScript: async () => [{ result: { found: false, visible: false, tagName: 'button' } }] }
    }
  }));
  const error = await captureRejection(
    handlers.pageWaitForSelector({ tabId: 1, selector: '#hidden', visible: true, timeoutMs: 25, intervalMs: 10 })
  );
  assert.equal(error.diagnostic.foundInDom, true);
  assert.equal(error.diagnostic.visible, false);
  assert.ok(error.message.includes('found but not visible'));
});

test('waitForText timeout reports a unified diagnostic', async () => {
  const { createPageHandlers } = await importPageModule();
  const handlers = createPageHandlers(makeDeps({
    chromeApi: {
      tabs: { get: async () => ({ id: 1, url: 'https://example.com', status: 'complete' }) },
      scripting: { executeScript: async () => [{ result: { found: false, selectorFound: true, textLength: 12, preview: 'hello world' } }] }
    }
  }));
  const error = await captureRejection(
    handlers.pageWaitForText({ tabId: 1, text: 'goodbye', timeoutMs: 25, intervalMs: 10 })
  );
  assertWaitTimeoutShape(error, {
    code: 'PAGE_WAIT_FOR_TEXT_TIMEOUT',
    type: 'PageWaitForTextTimeout',
    method: 'page.waitForText'
  });
  assert.equal(error.diagnostic.text, 'goodbye');
  assert.equal(error.diagnostic.selectorFound, true);
  assert.equal(error.diagnostic.observedTextLength, 12);
});

test('waitForText reports a missing scope selector', async () => {
  const { createPageHandlers } = await importPageModule();
  const handlers = createPageHandlers(makeDeps({
    chromeApi: {
      tabs: { get: async () => ({ id: 1, url: 'https://example.com', status: 'complete' }) },
      scripting: { executeScript: async () => [{ result: { found: false, selectorFound: false } }] }
    }
  }));
  const error = await captureRejection(
    handlers.pageWaitForText({ tabId: 1, text: 'x', selector: '#scope', timeoutMs: 25, intervalMs: 10 })
  );
  assert.equal(error.diagnostic.selectorFound, false);
  assert.ok(error.message.includes('scope selector'));
});

test('waitForURL timeout carries the current url', async () => {
  const { createPageHandlers } = await importPageModule();
  const handlers = createPageHandlers(makeDeps());
  const error = await captureRejection(
    handlers.pageWaitForURL({ tabId: 1, urlContains: 'never-here', timeoutMs: 25, intervalMs: 10 })
  );
  assertWaitTimeoutShape(error, {
    code: 'PAGE_WAIT_FOR_URL_TIMEOUT',
    type: 'PageWaitForURLTimeout',
    method: 'page.waitForURL'
  });
  assert.equal(error.diagnostic.currentUrl, 'https://example.com/start');
});

test('waitForNavigation timeout reports url stability', async () => {
  const { createPageHandlers } = await importPageModule();
  const handlers = createPageHandlers(makeDeps());
  const error = await captureRejection(
    handlers.pageWaitForNavigation({ tabId: 1, url: 'https://example.com/elsewhere', timeoutMs: 25, intervalMs: 10 })
  );
  assertWaitTimeoutShape(error, {
    code: 'PAGE_WAIT_FOR_NAVIGATION_TIMEOUT',
    type: 'PageWaitForNavigationTimeout',
    method: 'page.waitForNavigation'
  });
  assert.equal(error.diagnostic.urlChanged, false);
  assert.equal(error.diagnostic.currentUrl, 'https://example.com/start');
});

test('waitForNetworkIdle timeout reports inflight count', async () => {
  const { createPageHandlers } = await importPageModule();
  const events = new Map();
  events.set(1, [{
    method: 'Network.requestWillBeSent',
    timestamp: Date.now() + 1_000_000,
    params: { requestId: 'req-1' }
  }]);
  const handlers = createPageHandlers(makeDeps({ networkEventsByTab: events }));
  const error = await captureRejection(
    handlers.pageWaitForNetworkIdle({ tabId: 1, timeoutMs: 25, intervalMs: 10, idleMs: 10 })
  );
  assertWaitTimeoutShape(error, {
    code: 'PAGE_WAIT_FOR_NETWORK_IDLE_TIMEOUT',
    type: 'PageWaitForNetworkIdleTimeout',
    method: 'page.waitForNetworkIdle'
  });
  assert.equal(error.diagnostic.inflight, 1);
  assert.equal(error.diagnostic.maxInflight, 0);
});

test('waitForDialog timeout reports a unified diagnostic', async () => {
  const { createPageHandlers } = await importPageModule();
  const handlers = createPageHandlers(makeDeps());
  const error = await captureRejection(
    handlers.pageWaitForDialog({ tabId: 1, timeoutMs: 25, intervalMs: 10 })
  );
  assertWaitTimeoutShape(error, {
    code: 'PAGE_WAIT_FOR_DIALOG_TIMEOUT',
    type: 'PageWaitForDialogTimeout',
    method: 'page.waitForDialog'
  });
});
