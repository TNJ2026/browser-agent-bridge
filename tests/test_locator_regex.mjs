import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importLocatorModule() {
  const source = await readFile(new URL('../extension/sw/locator.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `result` is what the (mocked) in-page script returns for runLocatorScript.
async function makeHandlers(result) {
  const { createLocatorHandlers } = await importLocatorModule();
  return createLocatorHandlers({
    assertTabId: (v) => v,
    assertTabAllowed: async () => {},
    assertString: (v) => v,
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async () => ({}),
    captureElementScreenshot: async () => '',
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 }, frameSelector: null }),
    sleep,
    defaultTimeoutMs: 30,
    chromeApi: { scripting: { executeScript: async () => [{ result }] } }
  });
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the assertion to reject');
}

const COMMON = { tabId: 1, selector: 'x', timeoutMs: 25, intervalMs: 10 };

test('toHaveText matches a regex when regex:true', async () => {
  const handlers = await makeHandlers({ text: 'Order #1234 confirmed' });
  const res = await handlers.expectLocatorToHaveText({ ...COMMON, expectedText: '#\\d+', regex: true });
  assert.equal(res.ok, true);
});

test('toHaveText regex is case-insensitive by default and case-sensitive on request', async () => {
  const ci = await makeHandlers({ text: 'WELCOME back' });
  assert.equal((await ci.expectLocatorToHaveText({ ...COMMON, expectedText: 'welcome', regex: true })).ok, true);

  const cs = await makeHandlers({ text: 'WELCOME back' });
  const error = await captureRejection(
    cs.expectLocatorToHaveText({ ...COMMON, expectedText: 'welcome', regex: true, caseSensitive: true })
  );
  assert.equal(error.code, 'LOCATOR_EXPECT_TIMEOUT');
});

test('toHaveText regex that does not match times out', async () => {
  const handlers = await makeHandlers({ text: 'Order pending' });
  const error = await captureRejection(handlers.expectLocatorToHaveText({ ...COMMON, expectedText: '#\\d+', regex: true }));
  assert.equal(error.code, 'LOCATOR_EXPECT_TIMEOUT');
});

test('toHaveAttribute matches a regex when regex:true', async () => {
  const handlers = await makeHandlers({ value: '/items/42' });
  const res = await handlers.expectLocatorToHaveAttribute({ ...COMMON, attribute: 'href', expectedValue: '^/items/\\d+$', regex: true });
  assert.equal(res.ok, true);
});

test('an invalid regex does not throw — it just never matches', async () => {
  const handlers = await makeHandlers({ text: 'whatever' });
  const error = await captureRejection(handlers.expectLocatorToHaveText({ ...COMMON, expectedText: '[', regex: true }));
  assert.equal(error.code, 'LOCATOR_EXPECT_TIMEOUT');
});
