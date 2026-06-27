import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importLocatorModule() {
  const source = await readFile(new URL('../extension/sw/locator.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    keyboardDispatcher: {},
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

test('toBeEnabled passes for an enabled element', async () => {
  const handlers = await makeHandlers({ element: { disabled: false, editable: true, checked: false, value: '' } });
  const res = await handlers.expectLocatorToBeEnabled(COMMON);
  assert.equal(res.ok, true);
  assert.equal(res.actual, true);
});

test('toBeEnabled times out for a disabled element', async () => {
  const handlers = await makeHandlers({ element: { disabled: true } });
  const error = await captureRejection(handlers.expectLocatorToBeEnabled(COMMON));
  assert.equal(error.code, 'LOCATOR_EXPECT_TIMEOUT');
});

test('toBeDisabled passes for a disabled element', async () => {
  const handlers = await makeHandlers({ element: { disabled: true } });
  const res = await handlers.expectLocatorToBeDisabled(COMMON);
  assert.equal(res.ok, true);
});

test('toBeEditable passes for an editable element', async () => {
  const handlers = await makeHandlers({ element: { editable: true, disabled: false } });
  const res = await handlers.expectLocatorToBeEditable(COMMON);
  assert.equal(res.ok, true);
});

test('toBeChecked passes when checked and times out otherwise', async () => {
  const ok = await makeHandlers({ element: { checked: true } });
  assert.equal((await ok.expectLocatorToBeChecked(COMMON)).ok, true);

  const off = await makeHandlers({ element: { checked: false } });
  const error = await captureRejection(off.expectLocatorToBeChecked(COMMON));
  assert.equal(error.code, 'LOCATOR_EXPECT_TIMEOUT');

  const wantUnchecked = await makeHandlers({ element: { checked: false } });
  assert.equal((await wantUnchecked.expectLocatorToBeChecked({ ...COMMON, checked: false })).ok, true);
});

test('toHaveValue matches the element value', async () => {
  const handlers = await makeHandlers({ element: { value: 'hello world' } });
  const res = await handlers.expectLocatorToHaveValue({ ...COMMON, value: 'hello world' });
  assert.equal(res.ok, true);
  assert.equal(res.actual, 'hello world');
});

test('toHaveValue requires an expected string', async () => {
  const handlers = await makeHandlers({ element: { value: 'x' } });
  await assert.rejects(handlers.expectLocatorToHaveValue(COMMON), /requires expectedValue/);
});

test('toBeHidden passes when the locator resolves to no visible elements', async () => {
  const handlers = await makeHandlers({ count: 0, visibleCount: 0, elements: [] });
  const res = await handlers.expectLocatorToBeHidden(COMMON);
  assert.equal(res.ok, true);
  assert.equal(res.assertion, 'toBeHidden');
});

test('locator expectations delegate waiting to a single in-page script', async () => {
  const { createLocatorHandlers } = await importLocatorModule();
  const calls = [];
  const handlers = createLocatorHandlers({
    assertTabId: (v) => v,
    assertTabAllowed: async () => {},
    assertString: (v) => v,
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async () => ({}),
    captureElementScreenshot: async () => '',
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 }, frameSelector: null }),
    keyboardDispatcher: {},
    sleep,
    defaultTimeoutMs: 30,
    chromeApi: {
      scripting: {
        executeScript: async (opts) => {
          calls.push(opts);
          return [{ result: { count: 2, visibleCount: 2, elements: [] } }];
        }
      }
    }
  });

  const res = await handlers.expectLocatorToHaveCount({ ...COMMON, count: 2 });

  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].wait.kind, 'count');
  assert.equal(calls[0].args[0].wait.expected, 2);
});
