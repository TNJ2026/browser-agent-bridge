import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importDomModule() {
  const source = await readFile(new URL('../extension/sw/dom.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeHandlers(result) {
  const { createDomHandlers } = await importDomModule();
  return createDomHandlers({
    assertTabId: (v) => v,
    assertTabAllowed: async () => {},
    assertString: (v) => v,
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async () => ({}),
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 }, frameSelector: null, frameOffset: null }),
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
  throw new Error('expected the dom action to reject');
}

test('dom.click surfaces a structured actionability timeout', async () => {
  const handlers = await makeHandlers({
    found: false,
    count: 0,
    visibleCount: 0,
    actionability: { actionable: false, visible: false, reasons: ['not found'] }
  });
  const error = await captureRejection(handlers.domClick({ tabId: 1, selector: '#missing', timeoutMs: 25, intervalMs: 10 }));

  assert.equal(error.code, 'DOM_ACTIONABILITY_TIMEOUT');
  assert.equal(error.name, 'DomActionabilityTimeout');
  assert.equal(error.diagnostic.type, 'DomActionabilityTimeout');
  assert.equal(error.diagnostic.selector, '#missing');
  assert.equal(error.diagnostic.action, 'dom.click');
  assert.ok(error.diagnostic.reasons.includes('not found'));
  assert.equal(typeof error.diagnostic.elapsedMs, 'number');
});

test('dom.click strict timeout reports the match count in reasons', async () => {
  const handlers = await makeHandlers({
    found: true,
    count: 3,
    visibleCount: 3,
    element: { rect: { x: 0, y: 0, width: 10, height: 10 } },
    actionability: { actionable: true, visible: true, stable: true }
  });
  const error = await captureRejection(handlers.domClick({ tabId: 1, selector: 'button', strict: true, timeoutMs: 25, intervalMs: 10 }));

  assert.equal(error.code, 'DOM_ACTIONABILITY_TIMEOUT');
  assert.equal(error.diagnostic.strict, true);
  assert.ok(error.diagnostic.reasons.some(r => r.includes('strict mode expected 1 match, got 3')));
});

test('dom.click reports a non-actionable element with no clickable point', async () => {
  const handlers = await makeHandlers({
    found: true,
    count: 1,
    visibleCount: 1,
    element: { rect: { x: 0, y: 0, width: 10, height: 10 } }, // actionable but no clickPoint
    actionability: { actionable: true, visible: true, stable: true }
  });
  const error = await captureRejection(handlers.domClick({ tabId: 1, selector: 'button', stable: false, timeoutMs: 25, intervalMs: 10 }));

  assert.equal(error.code, 'DOM_ELEMENT_NOT_ACTIONABLE');
  assert.equal(error.name, 'DomElementNotActionable');
  assert.equal(error.diagnostic.selector, 'button');
  assert.equal(error.diagnostic.action, 'dom.click');
});
