import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function importPageModule() {
  const source = await readFile(new URL('../extension/sw/page.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

function makeHandlers(nodes) {
  const tree = {
    url: 'https://example.test/',
    title: 'Form',
    snapshotId: 'snap_1',
    frameId: 0,
    nodes,
    iframes: [],
    truncated: false
  };
  return importPageModule().then(({ createPageHandlers }) => createPageHandlers({
    assertTabId: v => v,
    assertString: v => v,
    assertTabAllowed: async () => {},
    assertUrlAllowed: async () => {},
    maybeEnableTemporaryCspBypassForUrl: async () => {},
    maybeEnableTemporaryCspBypass: async () => {},
    recordAction: async () => {},
    normalizeTab: t => t,
    waitForTabComplete: async () => {},
    sleep: async () => {},
    ensureContentScripts: async () => {},
    captureTabScreenshot: async () => '',
    attachDebugger: async () => {},
    cdp: async () => ({}),
    resolveFrameTarget: async tabId => ({ target: { tabId }, frame: { frameId: 0 } }),
    networkEventsByTab: new Map(),
    dialogsByTab: new Map(),
    defaultTimeoutMs: 30,
    chromeApi: {
      tabs: { async sendMessage() { return { ok: true, tree: structuredClone(tree) }; } },
      webNavigation: { async getAllFrames() { return [{ frameId: 0, url: tree.url }]; } }
    }
  }));
}

const NODES = [
  { ref: 'ref_1', frameId: 0, tag: 'h2', text: 'Billing' },
  { ref: 'ref_2', frameId: 0, tag: 'input', role: 'textbox', name: 'Email', type: 'email', value: 'a@b.com', focused: true },
  { ref: 'ref_3', frameId: 0, tag: 'input', role: 'checkbox', name: 'Subscribe', value: true },
  { ref: 'ref_4', frameId: 0, tag: 'a', role: 'link', name: 'Home', href: 'https://x/' }
];

test('format:compact renders a terse ref-tagged snapshot, no verbose nodes', async () => {
  const handlers = await makeHandlers(NODES);
  const res = await handlers.pageAccessibilityTree({ tabId: 1, format: 'compact' });
  assert.equal(res.snapshot, [
    '  Billing',
    '[f0:ref_2] textbox "Email" ="a@b.com" type=email [focused]',
    '[f0:ref_3] checkbox "Subscribe" [checked]',
    '[f0:ref_4] link "Home" -> https://x/'
  ].join('\n'));
  assert.equal(res.nodeCount, 4);
  assert.equal(res.snapshotId, 'snap_1');
  assert.equal('nodes' in res, false); // compact omits the verbose node array
});

test('compact snapshot disambiguates duplicate refs from different frames', async () => {
  const handlers = await makeHandlers([
    { ref: 'ref_1', frameId: 0, tag: 'button', role: 'button', name: 'Top Save' },
    { ref: 'ref_1', frameId: 7, tag: 'button', role: 'button', name: 'Frame Save' }
  ]);

  const res = await handlers.pageAccessibilityTree({ tabId: 1, format: 'compact' });

  assert.equal(res.snapshot, [
    '[f0:ref_1] button "Top Save"',
    '[f7:ref_1] button "Frame Save"'
  ].join('\n'));
});

test('default (no format) still returns the verbose node tree', async () => {
  const handlers = await makeHandlers(NODES);
  const res = await handlers.pageAccessibilityTree({ tabId: 1 });
  assert.ok(Array.isArray(res.nodes));
  assert.equal(res.nodes.length, 4);
  assert.equal('snapshot' in res, false);
});

test('compact snapshot is much smaller than the verbose tree', async () => {
  const handlers = await makeHandlers(NODES);
  const compact = await handlers.pageAccessibilityTree({ tabId: 1, format: 'compact' });
  const verbose = await handlers.pageAccessibilityTree({ tabId: 1 });
  assert.ok(compact.snapshot.length < JSON.stringify(verbose.nodes).length / 2,
    'compact should be < half the verbose JSON size');
});

async function importLocatorModule() {
  const source = await readFile(new URL('../extension/sw/locator.js', import.meta.url), 'utf8');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(dataUrl);
}

test('action resolvers automatically parse f{frameId}:{ref} prefix format', async () => {
  const { createLocatorHandlers } = await importLocatorModule();
  
  let sentMessage = null;
  let sentFrameId = null;

  const handlers = createLocatorHandlers({
    assertTabId: v => v,
    assertTabAllowed: async () => {},
    assertString: () => {},
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async () => {},
    resolveFrameTarget: async (tabId, params) => ({
      target: { tabId, frameIds: [params.frameId] },
      frameId: params.frameId,
      frame: { frameId: params.frameId },
      frameOffset: null
    }),
    ensureContentScripts: async () => {},
    chromeApi: {
      tabs: {
        async sendMessage(tabId, message, options) {
          sentMessage = message;
          sentFrameId = options.frameId;
          return {
            ok: true,
            target: {
              element: { clickPoint: { x: 5, y: 6 } },
              actionability: { actionable: true }
            }
          };
        }
      }
    }
  });

  // Call clickRef with f7:ref_99
  const res = await handlers.locatorClickRef({ tabId: 1, ref: 'f7:ref_99' });

  assert.equal(res.ok, true);
  // It should parse frameId: 7 and send message to frame 7
  assert.equal(sentFrameId, 7);
  // It should strip the f7: prefix when looking up in the frame content script
  assert.equal(sentMessage.ref, 'ref_99');
});

test('locatorSelectOptionRef automatically parses f{frameId}:{ref} prefix format', async () => {
  const { createLocatorHandlers } = await importLocatorModule();
  
  let sentMessage = null;
  let sentFrameId = null;

  const handlers = createLocatorHandlers({
    assertTabId: v => v,
    assertTabAllowed: async () => {},
    assertString: () => {},
    recordAction: async () => {},
    attachDebugger: async () => {},
    cdp: async () => {},
    resolveFrameTarget: async (tabId, params) => ({
      target: { tabId, frameIds: [params.frameId] },
      frameId: params.frameId,
      frame: { frameId: params.frameId },
      frameOffset: null
    }),
    ensureContentScripts: async () => {},
    chromeApi: {
      tabs: {
        async sendMessage(tabId, message, options) {
          sentMessage = message;
          sentFrameId = options.frameId;
          return {
            ok: true,
            target: {
              element: { tagName: 'select' },
              actionability: { actionable: true }
            },
            selected: [{ value: 'us', label: 'United States', index: 1 }]
          };
        }
      }
    }
  });

  const res = await handlers.locatorSelectOptionRef({ tabId: 1, ref: 'f12:ref_88', value: 'us' });

  assert.equal(res.ok, true);
  assert.equal(sentFrameId, 12);
  assert.equal(sentMessage.ref, 'ref_88');
});
