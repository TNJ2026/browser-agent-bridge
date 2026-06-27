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
  const scripts = [];
  const record = [];
  const handlers = createLocatorHandlers({
    assertTabId: (v) => v,
    assertTabAllowed: async () => {},
    assertString: (v) => v,
    recordAction: async (tabId, action, meta) => { record.push({ action, meta }); },
    attachDebugger: async () => {},
    cdp: async () => ({}),
    captureElementScreenshot: async () => '',
    resolveFrameTarget: async (tabId) => ({ target: { tabId }, frame: { frameId: 0 }, frameSelector: null }),
    keyboardDispatcher: {},
    sleep,
    defaultTimeoutMs: 30,
    chromeApi: { scripting: { executeScript: async (opts) => { scripts.push(opts.args?.[0]); return [{ result }]; } } }
  });
  return { handlers, scripts, record };
}

test('locator.boundingBox returns the element rect without scrolling', async () => {
  const rect = { x: 12, y: 34, width: 100, height: 40 };
  const { handlers, scripts } = await makeHandlers({ element: { index: 0, tagName: 'button', rect } });
  const res = await handlers.locatorBoundingBox({ tabId: 1, selector: 'button' });

  assert.deepEqual(res.boundingBox, rect);
  assert.equal(res.element.tagName, 'button');
  const opts = scripts.find(s => s.action === 'summarize');
  assert.ok(opts, 'expected a summarize action');
  assert.equal(opts.scrollIntoView, false); // boundingBox must not scroll
});

test('locator.focus runs the focus action and records it', async () => {
  const { handlers, scripts, record } = await makeHandlers({ element: { index: 0, tagName: 'input' } });
  const res = await handlers.locatorFocus({ tabId: 1, selector: 'input' });

  assert.equal(res.ok, true);
  assert.equal(res.element.tagName, 'input');
  const opts = scripts.find(s => s.action === 'focus');
  assert.ok(opts, 'expected a focus action');
  assert.equal(opts.force, true);
  assert.equal(record[0].action, 'locator.focus');
});
