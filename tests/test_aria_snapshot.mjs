import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importPageModule() {
  const source = await readFile(new URL('../extension/sw/page.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CDP Accessibility.getFullAXTree-shaped nodes.
const AX_NODES = [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'My Page' }, childIds: ['2', '3', '6'] },
  { nodeId: '2', role: { value: 'heading' }, name: { value: 'Welcome' }, properties: [{ name: 'level', value: { value: 2 } }], childIds: [] },
  { nodeId: '3', role: { value: 'generic' }, name: { value: '' }, childIds: ['4', '5'] },
  { nodeId: '4', role: { value: 'button' }, name: { value: 'Save' }, childIds: [] },
  { nodeId: '5', role: { value: 'checkbox' }, name: { value: 'Agree' }, properties: [{ name: 'checked', value: { value: 'true' } }], childIds: [] },
  { nodeId: '6', role: { value: 'link' }, name: { value: 'Hidden' }, ignored: true, childIds: [] }
];

async function makeHandlers(nodes = AX_NODES) {
  const { createPageHandlers } = await importPageModule();
  return createPageHandlers({
    assertTabId: (v) => v,
    assertString: (v, name) => { if (typeof v !== 'string' || !v) throw new Error(`${name} required`); return v; },
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
    cdp: async (tabId, method) => (method === 'Accessibility.getFullAXTree' ? { nodes } : {}),
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frameSelector: null, frame: { frameId: 0 } }),
    networkEventsByTab: new Map(),
    dialogsByTab: new Map(),
    defaultTimeoutMs: 30,
    chromeApi: { tabs: { get: async () => ({ id: 1 }) } }
  });
}

async function captureRejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

test('ariaSnapshot renders a compact role/name tree', async () => {
  const handlers = await makeHandlers();
  const res = await handlers.pageAriaSnapshot({ tabId: 1 });

  assert.ok(res.snapshot.includes('- RootWebArea "My Page"'));
  assert.ok(res.snapshot.includes('- heading "Welcome"[level=2]'));
  assert.ok(res.snapshot.includes('- button "Save"'));
  assert.ok(res.snapshot.includes('- checkbox "Agree"[checked]'));
  // transparent generic wrapper is dropped, its children promoted
  assert.ok(!res.snapshot.includes('generic'));
  // ignored node dropped
  assert.ok(!res.snapshot.includes('Hidden'));
});

test('ariaSnapshot promotes children of transparent wrappers under the root', async () => {
  const handlers = await makeHandlers();
  const res = await handlers.pageAriaSnapshot({ tabId: 1 });
  // button and checkbox sit one level under RootWebArea (2 spaces), not deeper
  assert.ok(res.snapshot.includes('\n  - button "Save"'));
  assert.ok(res.snapshot.includes('\n  - checkbox "Agree"[checked]'));
  assert.equal(typeof res.nodeCount, 'number');
});

test('toMatchAriaSnapshot matches an ordered subset', async () => {
  const handlers = await makeHandlers();
  const expected = '- heading "Welcome"\n- checkbox "Agree"';
  const res = await handlers.pageExpectAriaSnapshot({ tabId: 1, expected, timeoutMs: 30, intervalMs: 10 });
  assert.equal(res.ok, true);
});

test('toMatchAriaSnapshot times out and reports missing lines', async () => {
  const handlers = await makeHandlers();
  const error = await captureRejection(
    handlers.pageExpectAriaSnapshot({ tabId: 1, expected: '- button "Delete account"', timeoutMs: 25, intervalMs: 10 })
  );
  assert.equal(error.code, 'PAGE_EXPECT_ARIA_SNAPSHOT_TIMEOUT');
  assert.deepEqual(error.diagnostic.missing, ['button "Delete account"']);
});

test('toMatchAriaSnapshot enforces ordering', async () => {
  const handlers = await makeHandlers();
  // checkbox appears after the button in the tree; requesting button after checkbox fails
  const error = await captureRejection(
    handlers.pageExpectAriaSnapshot({ tabId: 1, expected: '- checkbox "Agree"\n- heading "Welcome"', timeoutMs: 25, intervalMs: 10 })
  );
  assert.equal(error.code, 'PAGE_EXPECT_ARIA_SNAPSHOT_TIMEOUT');
});

test('toMatchAriaSnapshot requires an expected snapshot', async () => {
  const handlers = await makeHandlers();
  await assert.rejects(handlers.pageExpectAriaSnapshot({ tabId: 1 }), /expected required/);
});
