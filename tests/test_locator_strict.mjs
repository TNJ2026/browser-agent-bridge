import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importLocatorModule() {
  const source = await readFile(new URL('../extension/sw/locator.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeElement(index, id) {
  return {
    index,
    tagName: 'button',
    id,
    role: 'button',
    accessibleName: 'Save',
    text: 'Save',
    visible: true,
    disabled: false,
    rect: { x: index * 10, y: 0, width: 40, height: 20 },
    clickPoint: { x: index * 10 + 20, y: 10 }
  };
}

async function makeHandlers(result, frame = { frameId: 0 }) {
  const { createLocatorHandlers } = await importLocatorModule();
  return createLocatorHandlers({
    assertTabId: (v) => v,
    assertTabAllowed: async () => {},
    assertString: (v) => v,
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async () => ({}),
    captureElementScreenshot: async () => '',
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame, frameSelector: null }),
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
  throw new Error('expected the locator action to reject');
}

test('strict mode violation reports every conflicting candidate', async () => {
  const elements = [makeElement(0, 'a'), makeElement(1, 'b'), makeElement(2, 'c')];
  const result = {
    found: true,
    count: 3,
    visibleCount: 3,
    elements,
    element: elements[0],
    actionability: { visible: true, enabled: true, receivesEvents: true, editable: true, selectable: true }
  };
  const handlers = await makeHandlers(result);
  const error = await captureRejection(
    handlers.locatorClick({ tabId: 1, selector: 'button', strict: true, timeoutMs: 25, intervalMs: 10 })
  );

  assert.equal(error.code, 'LOCATOR_STRICT_MODE_VIOLATION');
  assert.equal(error.name, 'LocatorStrictModeViolation');
  assert.equal(error.diagnostic.type, 'LocatorStrictModeViolation');
  assert.equal(error.diagnostic.count, 3);
  assert.equal(error.diagnostic.candidates.length, 3);
  assert.equal(error.diagnostic.candidatesTruncated, false);
  assert.equal(error.diagnostic.action, 'click');
  assert.equal(error.diagnostic.candidates[1].id, 'b');
  assert.ok(error.message.includes('Strict mode violation'));
  assert.ok(error.message.includes('resolved to 3 elements'));
});

test('strict mode marks candidatesTruncated when matches exceed the collection limit', async () => {
  const elements = Array.from({ length: 50 }, (_, i) => makeElement(i, `el-${i}`));
  const result = {
    found: true,
    count: 60,
    visibleCount: 60,
    elements,
    element: elements[0],
    actionability: { visible: true, enabled: true, receivesEvents: true, editable: true, selectable: true }
  };
  const handlers = await makeHandlers(result);
  const error = await captureRejection(
    handlers.locatorClick({ tabId: 1, selector: 'button', strict: true, timeoutMs: 25, intervalMs: 10 })
  );

  assert.equal(error.code, 'LOCATOR_STRICT_MODE_VIOLATION');
  assert.equal(error.diagnostic.count, 60);
  assert.equal(error.diagnostic.candidates.length, 50);
  assert.equal(error.diagnostic.candidatesTruncated, true);
  assert.ok(error.message.includes('more)'));
});

test('diagnostics surface the frame path for nested iframes', async () => {
  const elements = [makeElement(0, 'a'), makeElement(1, 'b')];
  const result = {
    found: true,
    count: 2,
    visibleCount: 2,
    elements,
    element: elements[0],
    actionability: { visible: true, enabled: true, receivesEvents: true, editable: true, selectable: true }
  };
  const frame = { frameId: 12, url: 'https://embed.example/b', framePath: [{ frameId: 0 }, { frameId: 7 }, { frameId: 12 }] };
  const handlers = await makeHandlers(result, frame);
  const error = await captureRejection(
    handlers.locatorClick({ tabId: 1, selector: 'button', strict: true, timeoutMs: 25, intervalMs: 10 })
  );

  assert.deepEqual(error.diagnostic.frame.framePath.map(f => f.frameId), [0, 7, 12]);
  assert.ok(error.message.includes('path: 0 > 7 > 12'), 'expected the frame path in the message');
});

test('strict mode with zero matches stays a not-found actionability timeout', async () => {
  const result = {
    found: false,
    count: 0,
    visibleCount: 0,
    elements: [],
    actionability: { visible: false, enabled: false, editable: false, reasons: ['not found'] }
  };
  const handlers = await makeHandlers(result);
  const error = await captureRejection(
    handlers.locatorClick({ tabId: 1, selector: 'button', strict: true, timeoutMs: 25, intervalMs: 10 })
  );

  assert.equal(error.code, 'LOCATOR_ACTIONABILITY_TIMEOUT');
  assert.equal(error.name, 'LocatorActionabilityTimeout');
});
